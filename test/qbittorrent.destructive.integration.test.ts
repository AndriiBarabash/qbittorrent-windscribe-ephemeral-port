/**
 * Destructive live integration test for qBittorrent's port update
 * (setPreferences listen_port).
 *
 * This MUTATES qBittorrent's listen port, so it only runs when RUN_DESTRUCTIVE
 * is set. It changes the port, asserts the change, then restores the original
 * value in a finally block. (updatePort also disables random_port as a side
 * effect, which is the app's intended setting and is left in place.)
 *
 * Run with:  RUN_DESTRUCTIVE=1 yarn test   (or: yarn test:destructive)
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {hasQbittorrentConfig, newQBittorrentClient, runDestructive} from './helpers.js';

const skip = !hasQbittorrentConfig
  ? 'CLIENT_URL / credentials not set'
  : !runDestructive
    ? 'set RUN_DESTRUCTIVE=1 to run (changes the qBittorrent listen port)'
    : false;

describe('qBittorrent port update (destructive, live)', {skip}, () => {
  it('updates the listen port and restores the original', async () => {
    const client = newQBittorrentClient();
    const original = await client.getPort();
    const testPort = original === 12345 ? 12346 : 12345;

    try {
      await client.updatePort(testPort);
      const updated = await client.getPort();
      assert.equal(updated, testPort, 'listen port should reflect the update');
    } finally {
      await client.updatePort(original);
    }

    const restored = await client.getPort();
    assert.equal(restored, original, 'listen port should be restored to its original value');
  });
});
