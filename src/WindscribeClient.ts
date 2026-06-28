import AsyncLock from 'async-lock';
import {default as axios} from 'axios';
import Keyv, {type KeyvStoreAdapter} from 'keyv';
import qs from 'qs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import {solveCaptcha} from './CaptchaSolver.js';


const lock = new AsyncLock();

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

// Base URL for Windscribe's JSON API, used for authentication.
const API_BASE_URL = 'https://api.windscribe.com';

// Static client secret used to sign every API request, extracted from the
// Windscribe clients. Each request must carry `time` (unix seconds) and
// `client_auth_hash = md5(CLIENT_AUTH_SECRET + time)`.
const CLIENT_AUTH_SECRET = '952b4412f002315aa50751032fcaab03';

// Windscribe issues ~24h sessions; used for local cache expiry only.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Build the `time` + `client_auth_hash` query string required to sign an API request.
function buildClientAuthQuery(): string {
  const time = Math.floor(Date.now() / 1000);
  const clientAuthHash = crypto.createHash('md5').update(CLIENT_AUTH_SECRET + time).digest('hex');
  return `time=${time}&client_auth_hash=${clientAuthHash}`;
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

  private async login(): Promise<{value: string, expires: Date}> {
    try {
      // Headers shared by both API requests. The Windscribe API is a JSON API
      // on api.windscribe.com (Origin/Referer must point at windscribe.com).
      const apiHeaders = {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://windscribe.com',
        'Referer': 'https://windscribe.com/',
      };

      // Step 1: Obtain a single-use secure token (and its signature) from the API.
      interface CaptchaChallenge {
        background: string;
        slider?: string;
        top: number;
        type?: string;
      }

      interface AuthTokenResponse {
        errorCode?: number;
        errorMessage?: string;
        data?: {
          token?: string;
          token_sig?: string;
          captcha?: CaptchaChallenge;
        };
      }

      const authResponse = await axios.post<AuthTokenResponse>(
        `${API_BASE_URL}/AuthToken/login?${buildClientAuthQuery()}`,
        {username: this.username, password: this.password},
        {headers: apiHeaders, validateStatus: status => status >= 200 && status < 500}
      );

      if (authResponse.data.errorCode) {
        throw new Error(`Auth token error (${authResponse.data.errorCode}): ${authResponse.data.errorMessage}`);
      }

      const secureToken = authResponse.data.data?.token;
      const secureTokenSig = authResponse.data.data?.token_sig;
      if (!secureToken || !secureTokenSig) {
        throw new Error('No token/token_sig in auth response');
      }

      // Solve a CAPTCHA challenge if one was returned (rare; only under bot suspicion).
      let captchaSolution: { offset: number; trail: { x: number[]; y: number[] } } | null = null;
      if (authResponse.data.data?.captcha?.background) {
        console.log('CAPTCHA challenge received, attempting to solve...');
        const captchaData = authResponse.data.data.captcha;
        captchaSolution = await solveCaptcha({
          background: captchaData.background,
          slider: captchaData.slider,
          top: captchaData.top,
        });
        console.log(`CAPTCHA solved: offset=${captchaSolution.offset}`);
      }
      console.log('Successfully obtained auth token' + (captchaSolution ? ' (with CAPTCHA)' : ''));

      // Step 2: Exchange the secure token for a session. The token is single-use,
      // so the 2FA code (when configured) must be sent in this same request.
      const sessionData: Record<string, unknown> = {
        username: this.username,
        password: this.password,
        session_type_id: 1,
        platform: 'legacy-web',
        secure_token: secureToken,
        secure_token_sig: secureTokenSig,
      };

      if (this.totp) {
        sessionData['2fa_code'] = this.totp.generate();
        console.log('Generated 2FA TOTP code for login');
      }

      // Field names inferred from the previous flow; only sent if a CAPTCHA was actually presented.
      if (captchaSolution) {
        sessionData.captcha_solution = captchaSolution.offset;
        sessionData.captcha_trail = {
          x: captchaSolution.trail.x,
          y: captchaSolution.trail.y,
        };
      }

      interface SessionResponse {
        errorCode?: number;
        errorMessage?: string;
        errorDescription?: string;
        data?: {
          session_auth_hash?: string;
        };
      }

      const sessionRes = await axios.post<SessionResponse>(
        `${API_BASE_URL}/Session?${buildClientAuthQuery()}`,
        sessionData,
        {headers: apiHeaders, validateStatus: status => status >= 200 && status < 500}
      );

      if (sessionRes.data.errorCode) {
        // 1340 = "Please provide a 2FA code"
        if (sessionRes.data.errorCode === 1340) {
          throw new Error('Windscribe 2FA required. Set the WINDSCRIBE_TOTP_SECRET environment variable.');
        }
        throw new Error(`Session error (${sessionRes.data.errorCode}): ${sessionRes.data.errorMessage ?? sessionRes.data.errorDescription}`);
      }

      const sessionAuthHash = sessionRes.data.data?.session_auth_hash;
      if (!sessionAuthHash) {
        throw new Error('No session_auth_hash in session response');
      }

      // This value is the ws_session_auth_hash cookie used for all windscribe.com requests.
      console.log('Successfully got login cookies');
      return {
        value: sessionAuthHash,
        expires: new Date(Date.now() + SESSION_TTL_MS),
      };
    } catch (error) {
      throw new Error(`Failed to log into windscribe: ${error.message}`);
    }
  }

  /**
   * Establish a fresh session against the Windscribe API and return the
   * resulting session hash. Intended for diagnostics / testing the login flow
   * in isolation from the port-forwarding logic.
   */
  async verifyLogin(): Promise<string> {
    return this.getSession(true);
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
