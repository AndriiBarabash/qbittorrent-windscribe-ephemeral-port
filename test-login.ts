/**
 * Standalone login smoke-test.
 *
 * Verifies ONLY the Windscribe authentication flow (api.windscribe.com) in
 * isolation from the port-forwarding logic. Reads the same environment
 * variables as the main app.
 *
 * Run with:
 *   node --import tsx test-login.ts
 */
import 'dotenv/config';
import {WindscribeClient} from './src/WindscribeClient.js';

async function main() {
  const username = process.env.WINDSCRIBE_USERNAME;
  const password = process.env.WINDSCRIBE_PASSWORD;
  const totpSecret = process.env.WINDSCRIBE_TOTP_SECRET;
  const flaresolverrUrl = process.env.FLARESOLVERR_URL ?? '';

  if (!username || !password) {
    console.error('Missing WINDSCRIBE_USERNAME / WINDSCRIBE_PASSWORD');
    process.exit(1);
  }

  // No cache passed -> Keyv runs in-memory, so this always performs a real login.
  const client = new WindscribeClient(username, password, flaresolverrUrl, undefined, totpSecret);

  console.log('Attempting Windscribe login...');
  const sessionHash = await client.verifyLogin();

  // Only show the non-secret prefix (userId:sessionType:issuedAt).
  const masked = sessionHash.split(':').slice(0, 3).join(':') + ':***';
  console.log('\n✅ LOGIN OK');
  console.log(`   session_auth_hash: ${masked}`);
}

main().catch(err => {
  console.error('\n❌ LOGIN FAILED');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
