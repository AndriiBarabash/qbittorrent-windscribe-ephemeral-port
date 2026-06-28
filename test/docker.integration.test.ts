/**
 * Live integration test for the optional Docker integration. Inspects the
 * configured containers (read-only — it does not restart anything). Skips itself
 * unless both GLUETUN_CONTAINER_NAME and QBITTORRENT_CONTAINER_NAME are set.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import {env} from './helpers.js';

const gluetun = env('GLUETUN_CONTAINER_NAME');
const qbittorrent = env('QBITTORRENT_CONTAINER_NAME');

describe('Docker (live)', {skip: gluetun && qbittorrent ? false : 'container names not configured'}, () => {
  const docker = new Docker({socketPath: '/var/run/docker.sock'});

  for (const name of [gluetun, qbittorrent]) {
    it(`inspects container "${name}"`, async () => {
      const info = await docker.getContainer(name!).inspect();
      assert.ok(info.State?.Status, `container "${name}" should report a state`);
    });
  }
});
