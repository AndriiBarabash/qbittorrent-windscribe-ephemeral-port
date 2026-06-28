/**
 * Health check / diagnostics command.
 *
 * Probes every live dependency the tool relies on — Windscribe (login, account
 * page, port read), qBittorrent, FlareSolverr, and (if configured) Docker — and
 * prints a per-stage report of what works and what's broken. Read-only: it does
 * not create/delete ports, change the torrent port, or restart containers.
 *
 * Run with:
 *   yarn doctor
 *
 * Exit code is non-zero if any critical check fails.
 */
import 'dotenv/config';
import {default as axios} from 'axios';
import Docker from 'dockerode';
import {getConfig} from './src/config.js';
import {WindscribeClient} from './src/WindscribeClient.js';
import {QBittorrentClient} from './src/QBittorrentClient.js';
import {CheckResult, printReport, runCheck, skipped} from './src/HealthCheck.js';

async function main() {
  const config = getConfig();
  const results: CheckResult[] = [];

  // --- Windscribe: login -> account/CSRF -> port read ---
  const windscribe = new WindscribeClient(
    config.windscribeUsername,
    config.windscribePassword,
    config.flaresolverrUrl,
    undefined, // no cache: always perform a real login
    config.windscribeTotpSecret,
  );
  results.push(...await windscribe.diagnose());

  // --- FlareSolverr: configured dependency (not used by the current login flow) ---
  results.push(await runCheck('FlareSolverr reachable', async () => {
    const res = await axios.post(
      config.flaresolverrUrl,
      {cmd: 'sessions.list'},
      {headers: {'Content-Type': 'application/json'}, timeout: 30000},
    );
    if (res.data?.status !== 'ok') {
      throw new Error(res.data?.message || 'unexpected FlareSolverr response');
    }
    return 'ok';
  }, {critical: false}));

  // --- qBittorrent: connect + read current listen port ---
  const qbit = new QBittorrentClient(
    config.clientUrl,
    config.clientUsername,
    config.clientPassword,
    config.clientApiKey,
  );
  results.push(await runCheck('qBittorrent reachable', async () => {
    const port = await qbit.getPort();
    return `connected, listen port ${port}`;
  }));

  // --- Docker: inspect the configured containers (only if both are set) ---
  if (config.gluetunContainerName && config.qbittorrentContainerName) {
    const docker = new Docker({socketPath: '/var/run/docker.sock'});
    for (const name of [config.gluetunContainerName, config.qbittorrentContainerName]) {
      results.push(await runCheck(`Docker container "${name}"`, async () => {
        const info = await docker.getContainer(name).inspect();
        return info.State?.Status ?? 'found';
      }));
    }
  } else {
    results.push(skipped('Docker containers', 'not configured'));
  }

  const ok = printReport(results);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('Health check crashed before completing:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
