/**
 * Destructive live integration test for the Windscribe port-forwarding write
 * endpoints: postEphPort (create) and deleteEphPort (delete).
 *
 * This MUTATES your Windscribe account, so it only runs when RUN_DESTRUCTIVE is
 * set. It performs a create/delete round trip and, via an `after` hook, leaves
 * the account in the normal desired state (a matching ephemeral port present).
 *
 * Run with:  RUN_DESTRUCTIVE=1 yarn test   (or: yarn test:destructive)
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import type {CsrfInfo, WindscribeClient} from '../src/WindscribeClient.js';
import {hasWindscribeCreds, newWindscribeClient, runDestructive} from './helpers.js';

const skip = !hasWindscribeCreds
  ? 'WINDSCRIBE_USERNAME/PASSWORD not set'
  : !runDestructive
    ? 'set RUN_DESTRUCTIVE=1 to run (mutates your Windscribe ephemeral port)'
    : false;

describe('Windscribe port forwarding — write (destructive, live)', {skip}, () => {
  let client: WindscribeClient;
  let csrf: CsrfInfo;

  before(async () => {
    client = newWindscribeClient();
    // The CSRF token is required by both write endpoints and is reusable across them.
    csrf = await client.getMyAccountCsrfToken();
  });

  it('creates a matching ephemeral port (postEphPort)', async () => {
    // Start from a clean slate so we exercise a real creation.
    const current = await client.getPortForwardingInfo();
    if (current.epfExpires > 0) {
      await client.removeEphemeralPort(csrf);
    }

    const created = await client.requestMatchingEphemeralPort(csrf);
    assert.ok(created.epfExpires > 0, 'created port should have an expiry');
    assert.ok(created.ports.length > 0 && created.ports[0] > 0, 'created port should expose a port number');

    // Confirm it is visible via the read endpoint too.
    const readback = await client.getPortForwardingInfo();
    assert.equal(readback.ports[0], created.ports[0], 'read-back port should match the created port');
  });

  it('deletes the ephemeral port (deleteEphPort)', async () => {
    await client.removeEphemeralPort(csrf);

    const afterDelete = await client.getPortForwardingInfo();
    assert.equal(afterDelete.epfExpires, 0, 'port should be gone after delete');
  });

  // Leave the account the way the app expects it: with a matching port active.
  after(async () => {
    if (!client || skip) {
      return;
    }
    const state = await client.getPortForwardingInfo();
    if (state.epfExpires === 0) {
      await client.requestMatchingEphemeralPort(csrf);
    }
  });
});
