import AsyncLock from 'async-lock';
import {default as axios} from 'axios';
import {Store, default as Keyv} from 'keyv';
import {Cookie, parse as parseCookie} from 'set-cookie-parser';
import qs from 'qs';


const lock = new AsyncLock();

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

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

  constructor(
    private username: string,
    private password: string,
    private flaresolverrUrl: string,
    cache?: Store<any>,
  ) {
    this.cache = new Keyv({
      store: cache,
      namespace: 'windscribe',
    });
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
      const getResponse = await axios.post(this.flaresolverrUrl, getPayload, {headers: {'Content-Type': 'application/json'}});
      if (getResponse.data.status !== 'ok') {
        throw new Error(`FlareSolverr failed for GET /login: ${getResponse.data.message}`);
      }
      const solution = getResponse.data.solution;
      const cfCookies = solution.cookies.reduce((acc: string[], c: any) => {
        if (c.name.startsWith('cf_') || c.name.startsWith('__cf')) acc.push(`${c.name}=${c.value}`);
        return acc;
      }, []);
      const cfUserAgent = solution.userAgent;

      if (cfCookies.length === 0) {
        throw new Error('No Cloudflare clearance cookies found in FlareSolverr response');
      }

      const cfCookieString = cfCookies.join('; ');

      // Step 2: Get CSRF token/time using CF cookies and UA (to associate with the session)
      let csrfDataObj: { csrf_time: number; csrf_token: string };
      try {
        const {data: csrfData} = await axios.post<{ csrf_token: string; csrf_time: number }>('https://res.windscribe.com/res/logintoken', null, {
          headers: {
            'User-Agent': cfUserAgent,
            'Cookie': cfCookieString,
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://windscribe.com/login',
            'Origin': 'https://windscribe.com',
          },
        });
        csrfDataObj = {csrf_time: csrfData.csrf_time, csrf_token: csrfData.csrf_token};
      } catch (csrfError) {
        throw new Error(`Failed to fetch CSRF with CF bypass: ${csrfError.message}`);
      }

      // Step 3: Perform actual POST with CF cookies, matching UA, and additional browser-like headers
      const loginFormData = qs.stringify({
        login: '1',
        upgrade: '0',
        csrf_time: csrfDataObj.csrf_time,
        csrf_token: csrfDataObj.csrf_token,
        username: this.username,
        password: this.password,
        code: '',
      });
      const loginRes = await axios.post('https://windscribe.com/login', loginFormData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': cfUserAgent,
          'Cookie': cfCookieString,
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
        // Check for error in HTML
        const errorMessage = /<div class="content_message error">.*>(.*)<\/div/.exec(loginRes.data);
        if (errorMessage && errorMessage[1]) {
          throw new Error(`Windscribe login error: ${errorMessage[1]}`);
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

      console.log('Successfully logged in with CF bypass');
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
      const ports = [...res.data.matchAll(/<span>(?<port>\d+)<\/span>/g)].map(x => +x[1]); // this will return an empty array when there are not pots forwarded

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
      throw new Error;
    }
  }

}
