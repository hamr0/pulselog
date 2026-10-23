// Alert email — the simple, paste-ready format ported from the plato/addypin
// health scripts: summary → per-failure detail → optional recent log tail →
// paste-ready GitHub issue. Sent via the system `mail`/`sendmail` (the box already
// runs Postfix), so this stays zero-dependency. Synchronous: a cron one-shot.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { spawnDelivery } from './deliver.js';

/**
 * Build the alert from the failing checks.
 * @param {{ failures: Array<{cfg: object, reason: string}>, host: string, ts: string, alert: object }} args
 * @returns {{ subject: string, body: string }}
 */
export function assembleEmail({ failures, host, ts, alert }) {
  const app = alert.app || host;
  const names = failures.map((f) => f.cfg.name).join(', ');
  const subject = `[${app}] health alert on ${host}: ${failures.length} check(s) failing`;

  const L = [];
  L.push(`${app} health check failed at ${ts}`);
  L.push(`host:    ${host}`);
  L.push(`failing: ${failures.length}`);
  L.push('');
  L.push('--- failures ---');
  for (const f of failures) L.push(`  ✗ ${f.cfg.name} [${f.cfg.type}]: ${f.reason}`);
  L.push('');

  if (alert.logTail) {
    L.push(`--- last 20 lines of ${alert.logTail} ---`);
    try {
      const tail = readFileSync(alert.logTail, 'utf8').trim().split('\n').filter(Boolean).slice(-20);
      L.push(tail.length ? tail.join('\n') : '(empty)');
    } catch {
      L.push('(unreadable)');
    }
    L.push('');
  }

  L.push('--- paste-ready issue ---');
  L.push(`Title: [${app}] health failure on ${host}: ${names}`);
  L.push('');
  L.push('## Failing checks');
  for (const f of failures) L.push(`- **${f.cfg.name}** (${f.cfg.type}): ${f.reason}`);
  L.push('');
  L.push(`When: ${ts}`);

  return { subject, body: L.join('\n') + '\n' };
}

/** Default bound on the primary MTA handoff (0.8.0). A healthy local handoff takes ~1s. */
export const PRIMARY_TIMEOUT_MS = 30_000;

/** True if `cmd` is on PATH. */
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/**
 * Send via `mail`, else `sendmail`, else warn to stderr (never throw). Reports the local
 * handoff outcome: `transport` names the tool used (`'none'` when no MTA is on PATH), and
 * `ok` is whether that handoff exited cleanly. NB: a clean handoff (`ok:true`) means
 * *queued*, not *delivered* — an async bounce can still follow. The fallback alert sink
 * (0.7.0) reads `ok` to decide whether to fire on `on-primary-failure`.
 *
 * 0.8.0: the handoff is bounded by `timeoutMs` (default 30s). A sandboxed unit can leave
 * `postdrop` retrying forever (NoNewPrivileges drops its setgid bit), so an unbounded
 * handoff would block the fallback and the whole run. A timeout is `ok:false`,
 * `reason:'timeout'`, and the handoff's process group is killed. `reason` names the cause
 * (`'timeout'`, `'exit N'`, an errno, `'no-mta'`), null on a clean handoff.
 * @param {{ to: string, from?: string, subject: string, body: string, timeoutMs?: number }} msg
 * @returns {{ transport: 'mail'|'sendmail'|'none', ok: boolean, reason: string|null }}
 */
export function sendEmail({ to, from, subject, body, timeoutMs }) {
  // Header fields must be single-line: a newline in any of them (they can come from
  // config) would inject extra mail headers (e.g. a Bcc:). Body may keep its newlines.
  const oneLine = (s) => (s == null ? s : String(s).replace(/[\r\n]+/g, ' '));
  to = oneLine(to); from = oneLine(from); subject = oneLine(subject);
  const t = Math.floor(Number(timeoutMs));
  const timeout = Number.isFinite(t) && t > 0 ? t : PRIMARY_TIMEOUT_MS;
  if (has('mail')) {
    const args = ['-s', subject];
    if (from) args.push('-r', from);
    args.push(to);
    const { ok, reason } = spawnDelivery('mail', args, { input: body, timeoutMs: timeout });
    return { transport: 'mail', ok, reason };
  }
  if (has('sendmail')) {
    const headers = [from && `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '']
      .filter(Boolean)
      .join('\n');
    const { ok, reason } = spawnDelivery('sendmail', ['-t'], { input: headers + '\n' + body, timeoutMs: timeout });
    return { transport: 'sendmail', ok, reason };
  }
  process.stderr.write(`pulselog: no \`mail\`/\`sendmail\` on PATH; would alert ${to}: ${subject}\n`);
  return { transport: 'none', ok: false, reason: 'no-mta' };
}
