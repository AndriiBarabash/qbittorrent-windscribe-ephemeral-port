/**
 * Tiny helpers for the `yarn doctor` health check: run a probe against a live
 * dependency, capture whether it worked, and render a readable per-stage report.
 */

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
}

/**
 * Run a single check. The probe should return a short detail string on success
 * or throw on failure. Failures are reported as 'fail' (counts against the exit
 * code) unless `critical: false`, in which case they are a non-fatal 'warn'.
 */
export async function runCheck(
  name: string,
  probe: () => Promise<string | void>,
  opts: { critical?: boolean } = {},
): Promise<CheckResult> {
  try {
    const detail = await probe();
    return {name, status: 'ok', detail: detail || undefined};
  } catch (err) {
    return {
      name,
      status: opts.critical === false ? 'warn' : 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a 'skip' result for a stage that wasn't attempted. */
export function skipped(name: string, reason: string): CheckResult {
  return {name, status: 'skip', detail: reason};
}

const ICONS: Record<CheckStatus, string> = {
  ok: '✅',
  fail: '❌',
  warn: '⚠️ ',
  skip: '➖',
};

/**
 * Print the report. Returns true if no critical check failed (i.e. nothing has
 * status 'fail'), so the caller can use it as the process exit status.
 */
export function printReport(results: CheckResult[]): boolean {
  const width = Math.max(...results.map(r => r.name.length));

  console.log('\n──────── health check ────────');
  for (const r of results) {
    const detail = r.detail ? `  ${r.detail}` : '';
    console.log(`${ICONS[r.status]} ${r.name.padEnd(width)}${detail}`);
  }

  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;

  console.log('──────────────────────────────');
  if (failed > 0) {
    console.log(`Result: ${failed} check(s) FAILED${warned ? `, ${warned} warning(s)` : ''}.`);
  } else {
    console.log(`Result: all critical checks passed${warned ? `, ${warned} warning(s)` : ''}.`);
  }

  return failed === 0;
}
