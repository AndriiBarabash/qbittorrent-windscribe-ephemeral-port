import axios, {type AxiosInstance} from 'axios';
import qs from 'qs';

export class QBittorrentClient {

  private http: AxiosInstance;
  private sessionCookie?: string; // "NAME=VALUE" for Cookie header

  constructor(
    url: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.http = axios.create({baseURL: url.replace(/\/$/, '')});
  }

  async updateConnection(): Promise<{hostId: string; version: string}> {
    await this.login();

    const [apiVersion, appVersion] = await Promise.all([
      this.http.get<string>('/api/v2/app/webapiVersion', {headers: this.authHeaders()}),
      this.http.get<string>('/api/v2/app/version', {headers: this.authHeaders()}),
    ]);

    return {
      hostId: apiVersion.data,
      version: appVersion.data,
    };
  }

  async getPort(): Promise<number> {
    await this.updateConnection();

    const prefs = await this.http.get<{listen_port: number}>(
      '/api/v2/app/preferences',
      {headers: this.authHeaders()},
    );

    return prefs.data.listen_port;
  }

  async updatePort(port: number): Promise<void> {
    await this.updateConnection();

    await this.http.post(
      '/api/v2/app/setPreferences',
      qs.stringify({json: JSON.stringify({listen_port: port, random_port: false})}),
      {headers: this.authHeaders()},
    );

    console.log('Client port update requested.');
  }

  private async login(): Promise<void> {
    const response = await this.http.post(
      '/api/v2/auth/login',
      qs.stringify({username: this.username, password: this.password}),
      {
        // Follow redirects but capture Set-Cookie from the login response
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
      },
    );

    // qBittorrent ≤5.1.x sets "SID=...", ≥5.2 sets "QBT_SID_<port>=..."
    const setCookie = response.headers['set-cookie'];
    const sidCookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
      .map((c) => c.split(';')[0].trim())
      .find((c) => c.startsWith('SID=') || c.startsWith('QBT_SID_'));

    if (!sidCookie) {
      throw new Error('Invalid cookie');
    }

    this.sessionCookie = sidCookie;
  }

  private authHeaders(): Record<string, string> {
    if (!this.sessionCookie) throw new Error('Not logged in');
    return {Cookie: this.sessionCookie};
  }

}
