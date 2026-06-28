/**
 * Live integration test for qBittorrent connectivity. Read-only: connects and
 * reads the current listen port without changing anything.
 *
 * Requires CLIENT_URL and credentials (CLIENT_API_KEY, or CLIENT_USERNAME +
 * CLIENT_PASSWORD); the suite skips itself otherwise.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {hasQbittorrentConfig, newQBittorrentClient} from './helpers.js';

describe('qBittorrent (live)', {skip: hasQbittorrentConfig ? false : 'CLIENT_URL / credentials not set'}, () => {
  it('connects and reads the current listen port', async () => {
    const client = newQBittorrentClient();
    const port = await client.getPort();
    assert.ok(typeof port === 'number' && port > 0, `expected a numeric listen port, got ${port}`);
  });
});
