/**
 * Shared setup for the live integration tests. Not a test file itself (it does
 * not match *.integration.test.ts), so the runner only imports it.
 *
 * Reads the same environment variables as the app (via a .env file or the
 * process environment) and exposes guards so suites self-skip when the relevant
 * configuration is absent.
 */
import 'dotenv/config';
import type {KeyvStoreAdapter} from 'keyv';
import {WindscribeClient} from '../src/WindscribeClient.js';
import {QBittorrentClient} from '../src/QBittorrentClient.js';

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const hasWindscribeCreds = Boolean(env('WINDSCRIBE_USERNAME') && env('WINDSCRIBE_PASSWORD'));
export const hasQbittorrentConfig = Boolean(
  env('CLIENT_URL') && (env('CLIENT_API_KEY') || (env('CLIENT_USERNAME') && env('CLIENT_PASSWORD'))),
);

export function newWindscribeClient(): WindscribeClient {
  // A Map-backed cache persists in-memory, so the login from the first test is
  // reused by the later stage tests (a single authentication per run).
  const cache = new Map() as unknown as KeyvStoreAdapter;
  return new WindscribeClient(
    env('WINDSCRIBE_USERNAME')!,
    env('WINDSCRIBE_PASSWORD')!,
    env('FLARESOLVERR_URL') ?? '',
    cache,
    env('WINDSCRIBE_TOTP_SECRET'),
  );
}

export function newQBittorrentClient(): QBittorrentClient {
  return new QBittorrentClient(
    env('CLIENT_URL')!,
    env('CLIENT_USERNAME'),
    env('CLIENT_PASSWORD'),
    env('CLIENT_API_KEY'),
  );
}
