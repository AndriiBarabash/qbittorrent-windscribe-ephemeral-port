import AsyncLock from 'async-lock';
import {default as axios} from 'axios';
import Keyv, {type KeyvStoreAdapter} from 'keyv';
import {Cookie, parse as parseCookie} from 'set-cookie-parser';
import qs from 'qs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import {solveCaptcha} from './CaptchaSolver.js';


const lock = new AsyncLock();

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

// Secret key used for signing the auth token (from Windscribe's login JS)
const AUTH_TOKEN_SECRET = 'my_mom_told_me_this_is_peak_engineering';

// Helper functions for generating login parameters
function generateNonce(): string {
  return Math.random().toString(36).substring(2, 15);
}

function generateSessionId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateRequestId(): string {
  const random = crypto.randomBytes(16);
  const hash = crypto.createHash('sha256').update(random).digest();
  return hash.slice(0, 16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 24);
}

function computeTokenSignature(token: string): string {
  return crypto.createHash('sha256').update(token + AUTH_TOKEN_SECRET).digest('hex');
}

interface CsrfInfo {
  csrfTime: number;
  csrfToken: string;
}

interface PortForwardingInfo {
  epfExpires: number;
  ports: number[];
}

export interface WindscribePort {
  port: number,
  expires: Date,
}

export class WindscribeClient {

  private cache: Keyv<string>;
  private readonly totp: OTPAuth.TOTP | null = null;

  constructor(
    private username: string,
    private password: string,
    private flaresolverrUrl: string,
    cache?: KeyvStoreAdapter,
    totpSecret?: string,
  ) {
    this.cache = new Keyv({
      store: cache,
      namespace: 'windscribe',
    });

    if (totpSecret) {
      this.totp = new OTPAuth.TOTP({
        issuer: 'Windscribe',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: totpSecret,
      });
      console.log('2FA TOTP configured for Windscribe login');
    }
  }

  async updatePort(): Promise<WindscribePort> {
    // get csrf token and time to pass on to future requests
    // this will also verify if we are logged in and login if not
    const csrfToken = await this.getMyAccountCsrfToken();

    // check for current status
    let portForwardingInfo = await this.getPortForwardingInfo();

    // check for mismatched ports if any present
    if (portForwardingInfo.ports.length == 2 && portForwardingInfo.ports[0] != portForwardingInfo.ports[1]) {
      console.log('Detected mismatched ports, removing existing ports');
      await this.removeEphemeralPort(csrfToken);

      // update data to match current state
      portForwardingInfo.ports = [];
      portForwardingInfo.epfExpires = 0;
      await this.cache.delete('port');
    }

    // request new port if we don't have any
    if (portForwardingInfo.epfExpires == 0) {
      console.log('No windscribe port configured, requesting new matching ephemeral port');
      portForwardingInfo = await this.requestMatchingEphemeralPort(csrfToken);
    } else {
      console.log(`Using existing windscribe ephemeral port: ${portForwardingInfo.ports[0]}`);
    }

    const ret = {
      port: portForwardingInfo.ports[0],
      expires: new Date((portForwardingInfo.epfExpires + 86400 * 7) * 1000),
    };

    await this.cache.set('port', ret.port.toString(), ret.expires.getTime() - Date.now());

    return ret;
  }

  async getPort(): Promise<WindscribePort | null> {
    const cachedPort = await this.cache.get('port', {raw: true});
    return cachedPort == undefined ? null : {
      port: parseInt(cachedPort.value),
      expires: new Date(cachedPort.expires),
    };
  }

  private async getSession(forceLogin: boolean = false): Promise<string> {
    return lock.acquire('getSession', async () => {
      if (forceLogin) {
        // force clear the session
        await this.cache.delete('sessionCookie');
      } else {
        // try to get cached value
        const cachedCookie = await this.cache.get('sessionCookie');
        if (cachedCookie != undefined) {
          return cachedCookie;
        }
      }

      // get a new session
      console.log(`Invalid/missing session cookie, logging into windscribe`);
      const sessionCookie = await this.login();
      await this.cache.set('sessionCookie', sessionCookie.value, sessionCookie.expires.getTime() - Date.now());
      console.log(`Successfully logged into windscribe, session expires in ${Math.floor((sessionCookie.expires.getTime() - Date.now()) / (100 * 60)) / 10} minutes`);

      return sessionCookie.value;
    });
  }

  private async login(): Promise<Cookie> {
    try {
      // Step 1: Use FlareSolverr to GET /login and solve CF, getting cf_clearance cookie and User-Agent
      const getPayload = {
        cmd: 'request.get',
        url: 'https://windscribe.com/login',
        maxTimeout: 60000,
      };
      const flareResponse = await axios.post(this.flaresolverrUrl, getPayload, {headers: {'Content-Type': 'application/json'}});
      if (flareResponse.data.status !== 'ok') {
        throw new Error(`FlareSolverr failed for GET /login: ${flareResponse.data.message}`);
      }
      if (!flareResponse.data.solution.cookies.some(({name}) => name.startsWith('cf_'))) {
        throw new Error('No Cloudflare clearance cookies found in FlareSolverr response');
      }
      console.log('Successfully solved CF challenge using FlareSolverr');

      const cfCookies = flareResponse.data.solution.cookies
        .map(({name, value}) =>`${name}=${value}`)
        .join('; ');
      const cfUserAgent = flareResponse.data.solution.userAgent;

      // Step 2: Get auth token from /authtoken/login endpoint
      interface CaptchaChallenge {
        background: string;
        slider?: string;
        top: number;
        type: string;
      }

      interface AuthTokenResponse {
        errorCode?: number;
        errorMessage?: string;
        data?: {
          token: string;
          token_id?: string;
          captcha?: CaptchaChallenge;
          access_level?: number;
          signature?: string;
          algorithm?: string;
          version?: string;
          request_id?: string;
          entropy?: {
            e: string;
            s: string;
          };
        };
      }

      let authToken: string;
      let captchaSolution: { offset: number; trail: { x: number[]; y: number[] } } | null = null;

      try {
        const authResponse = await axios.post<AuthTokenResponse>(
          'https://windscribe.com/authtoken/login',
          qs.stringify({username: this.username, password: this.password}),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': cfUserAgent,
              'Cookie': cfCookies,
              'Accept': 'application/json, text/plain, */*',
              'Referer': 'https://windscribe.com/login',
              'Origin': 'https://windscribe.com',
            },
          }
        );

        if (authResponse.data.errorCode) {
          throw new Error(`Auth token error (${authResponse.data.errorCode}): ${authResponse.data.errorMessage}`);
        }

        if (!authResponse.data.data?.token) {
          throw new Error('No token in auth response');
        }

        // Check if CAPTCHA is required (captcha data present means we need to solve it)
        if (authResponse.data.data.captcha?.background) {
          console.log('CAPTCHA challenge received, attempting to solve...');
          console.log('CAPTCHA data keys:', Object.keys(authResponse.data.data.captcha));

          const captchaData = authResponse.data.data.captcha;

          // Solve the CAPTCHA using image processing
          captchaSolution = await solveCaptcha({
            background: captchaData.background,
            slider: captchaData.slider,
            top: captchaData.top,
          });

          console.log(`CAPTCHA solved: offset=${captchaSolution.offset}`);
        }

        authToken = authResponse.data.data.token;
        console.log('Successfully obtained auth token' + (captchaSolution ? ' (with CAPTCHA)' : ''));
      } catch (err) {
        if (err.message.includes('Auth token error') || err.message.includes('CAPTCHA')) {
          throw err;
        }
        throw new Error(`Failed to fetch auth token: ${err.message}`);
      }

      // Step 3: Compute signature and generate login parameters
      const secureTokenSig = computeTokenSignature(authToken);
      const timestamp = Date.now();
      const nonce = generateNonce();
      const sessionId = generateSessionId();
      const requestId = generateRequestId();

      // Step 4: Build login form data
      const loginData: Record<string, unknown> = {
        login: '1',
        username: this.username,
        password: this.password,
        secure_token: authToken,
        secure_token_sig: secureTokenSig,
        timestamp: timestamp,
        nonce: nonce,
        client_version: '1.0.0',
        session_id: sessionId,
        request_id: requestId,
        upgrade: '0',
      };

      // Add 2FA code if TOTP is configured
      if (this.totp) {
        loginData.code = this.totp.generate();
        console.log('Generated 2FA TOTP code for login');
      }

      // Add CAPTCHA solution if required
      if (captchaSolution) {
        loginData.captcha_solution = captchaSolution.offset;
        loginData.captcha_trail = {
          x: captchaSolution.trail.x,
          y: captchaSolution.trail.y,
        };
      }

      // Step 5: Perform actual POST with all parameters
      const loginFormData = qs.stringify(loginData, {arrayFormat: 'indices'});
      const loginRes = await axios.post('https://windscribe.com/login', loginFormData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': cfUserAgent,
          'Cookie': cfCookies,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://windscribe.com',
          'Referer': 'https://windscribe.com/login',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 0,
        validateStatus: status => [200, 302].includes(status), // Handle 200 error or 302 success
      });

      if (loginRes.status === 200) {
        // Check for error in HTML: <div class="content_message error"><i></i>Error text</div> or <div class="content_message error">Error text</div>
        const errorMatch = /<div class="content_message error">(?:<i><\/i>)?([^<]+)<\/div>/.exec(loginRes.data);
        if (errorMatch && errorMatch[1]) {
          const errorText = errorMatch[1].trim();
          if (errorText.toLowerCase().includes('2fa')) {
            throw new Error(`Windscribe 2FA required: ${errorText}. Set WINDSCRIBE_TOTP_SECRET environment variable.`);
          }
          throw new Error(`Windscribe login error: ${errorText}`);
        }
        throw new Error('Received 200 but no expected error message; check response');
      }

      // Extract ws_session_auth_hash from Set-Cookie header
      const setCookieHeaders = loginRes.headers['set-cookie'];
      if (!setCookieHeaders) {
        throw new Error('No Set-Cookie header in login response');
      }
      const wsSessionCookie = parseCookie(setCookieHeaders, {map: true, decodeValues: true})['ws_session_auth_hash'];
      if (!wsSessionCookie) {
        throw new Error('Failed to find ws_session_auth_hash in Set-Cookie');
      }

      console.log('Successfully got login cookies');
      return wsSessionCookie;
    } catch (error) {
      throw new Error(`Failed to log into windscribe: ${error.message}`);
    }
  }

  private async getMyAccountCsrfToken(forceLogin: boolean = false): Promise<CsrfInfo> {
    try {
      const sessionCookie = await this.getSession(forceLogin);

      // get page
      const res = await axios.get<string>('https://windscribe.com/myaccount', {
        headers: {
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': userAgent,
        },
        maxRedirects: 0,
        validateStatus: status => [302, 200].includes(status),
      });

      if (res.status == 302) {
        // force to login again as the current session is invalid
        return await this.getMyAccountCsrfToken(true);
      }

      // extract csrf tokena and time from page content
      const csrfTime = /csrf_time = (\d+);/.exec(res.data)[1];
      const csrfToken = /csrf_token = '(\w+)';/.exec(res.data)[1];

      return {
        csrfTime: +csrfTime,
        csrfToken: csrfToken,
      };
    } catch (error) {
      throw new Error(`Failed to get csrf token from my account page: ${error.message}`);
    }
  }

  private async getPortForwardingInfo(): Promise<PortForwardingInfo> {
    try {
      const sessionCookie = await this.getSession();

      // load sub page
      const res = await axios.get<string>('https://windscribe.com/staticips/load', {
        headers: {
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': userAgent,
        }
      });

      // extract data from page
      const epfExpires = res.data.match(/epfExpires = (\d+);/)[1]; // this is always present. set to 0 if no port is active
      // Extract ports from the new UI structure: <span class="pf-ext">10583</span> and <span class="pf-int">10011</span>
      const extPort = res.data.match(/<span class="pf-ext">(\d+)<\/span>/)?.[1];
      const intPort = res.data.match(/<span class="pf-int">(\d+)<\/span>/)?.[1];
      const ports = [extPort, intPort].filter((p): p is string => p !== undefined).map(p => +p);

      return {
        epfExpires: +epfExpires,
        ports,
      };
    } catch (error) {
      throw new Error(`Failed to get port forwarding info: ${error.message}`);
    }
  }

  private async removeEphemeralPort(csrfInfo: CsrfInfo): Promise<void> {
    try {
      const sessionCookie = await this.getSession();

      // remove port
      const res = await axios.post<{success: number, epf: boolean, message?: string}>('https://windscribe.com/staticips/deleteEphPort', qs.stringify({
        ctime: csrfInfo.csrfTime,
        ctoken: csrfInfo.csrfToken
      }), {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': userAgent,
        }
      });

      // check for errors
      if (res.data.success == 0) {
        throw new Error(`success = 0; ${res.data.message ?? 'No message'}`);
      }

      // make sure we actually removed it
      if (res.data.epf == false) {
        console.warn('Tried to remove a non-existent ephemeral port, ignoring');
      } else {
        console.log('Deleted ephemeral port');
      }
    } catch (error) {
      throw new Error(`Failed to delete ephemeral port: ${error.message}`);
    }
  }

  private async requestMatchingEphemeralPort(csrfInfo: CsrfInfo): Promise<PortForwardingInfo> {
    try {
      const sessionCookie = await this.getSession();

      // request new port
      const res = await axios.post<{success: number, message?: string, epf?: {ext: number, int: number, start_ts: number}}>('https://windscribe.com/staticips/postEphPort', qs.stringify({
        ctime: csrfInfo.csrfTime,
        ctoken: csrfInfo.csrfToken,
        port: '', // empty string for a matching port
      }), {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'Cookie': `ws_session_auth_hash=${sessionCookie};`,
          'User-Agent': userAgent,
        }
      });

      // check for errors
      if (res.data.success == 0) {
        throw new Error(`success = 0; ${res.data.message ?? 'No message'}`);
      }

      // epf should be present by this point
      const epf = res.data.epf!;
      console.log(`Created new matching ephemeral port: ${epf.ext}`);
      return {
        epfExpires: epf.start_ts,
        ports: [epf.ext, epf.int],
      };
    } catch (error) {
      throw new Error(`Failed to request matching ephemeral port: ${error instanceof Error ? error.message : error}`);
    }
  }

}
