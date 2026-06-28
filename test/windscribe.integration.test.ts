/**
 * Live integration test for the Windscribe flow: login -> account/CSRF -> port
 * read. Each stage is its own test, so a failure points straight at the call
 * that broke. Read-only: it never creates, deletes, or changes a port.
 *
 * Requires WINDSCRIBE_USERNAME / WINDSCRIBE_PASSWORD (and WINDSCRIBE_TOTP_SECRET
 * if the account uses 2FA); the suite skips itself otherwise.
 */
import {before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import type {WindscribeClient} from '../src/WindscribeClient.js';
import {hasWindscribeCreds, newWindscribeClient} from './helpers.js';

describe('Windscribe (live)', {skip: hasWindscribeCreds ? false : 'WINDSCRIBE_USERNAME/PASSWORD not set'}, () => {
  let client: WindscribeClient;

  before(() => {
    client = newWindscribeClient();
  });

  it('logs in via api.windscribe.com', async () => {
    const sessionHash = await client.verifyLogin();
    // session_auth_hash looks like userId:sessionType:issuedAt:...
    assert.match(sessionHash, /^\d+:\d+:\d+:/, `unexpected session hash: ${sessionHash}`);
  });

  it('reads the account CSRF token (myaccount)', async () => {
    const {csrfToken, csrfTime} = await client.getMyAccountCsrfToken();
    assert.ok(csrfToken, 'csrf_token should be present on the account page');
    assert.ok(csrfTime > 0, 'csrf_time should be a positive timestamp');
  });

  it('reads the port-forwarding state (staticips/load)', async () => {
    const info = await client.getPortForwardingInfo();
    assert.ok(info.epfExpires >= 0, 'epfExpires should be present (0 when no port is active)');
    if (info.epfExpires > 0) {
      assert.ok(info.ports.length > 0, 'an active ephemeral port forward should expose at least one port');
    }
  });
});
