/**
 * Live integration test for FlareSolverr reachability. FlareSolverr is no longer
 * used by the login flow, but it remains a configured dependency, so this checks
 * the endpoint still answers. Skips itself when FLARESOLVERR_URL is not set.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {default as axios} from 'axios';
import {env} from './helpers.js';

const flaresolverrUrl = env('FLARESOLVERR_URL');

describe('FlareSolverr (live)', {skip: flaresolverrUrl ? false : 'FLARESOLVERR_URL not set'}, () => {
  it('responds to sessions.list', async () => {
    const res = await axios.post(
      flaresolverrUrl!,
      {cmd: 'sessions.list'},
      {headers: {'Content-Type': 'application/json'}, timeout: 30000},
    );
    assert.equal(res.data?.status, 'ok', `unexpected FlareSolverr response: ${JSON.stringify(res.data)}`);
  });
});
