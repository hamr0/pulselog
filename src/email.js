// Alert email — the simple, paste-ready format ported from the plato/addypin
// health scripts: summary → per-failure detail → optional recent log tail →
// paste-ready GitHub issue. Sent via the system `mail`/`sendmail` (the box already
// runs Postfix), so this stays zero-dependency. Synchronous: a cron one-shot.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

/** True if `cmd` is on PATH. */
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/**
 * Send via `mail`, else `sendmail`, else warn to stderr (never throw).
 * @returns {'mail'|'sendmail'|'none'}
 */
export function sendEmail({ to, from, subject, body }) {
  // Header fields must be single-line: a newline in any of them (they can come from
  // config) would inject extra mail headers (e.g. a Bcc:). Body may keep its newlines.
  const oneLine = (s) => (s == null ? s : String(s).replace(/[\r\n]+/g, ' '));
  to = oneLine(to); from = oneLine(from); subject = oneLine(subject);
  if (has('mail')) {
    const args = ['-s', subject];
    if (from) args.push('-r', from);
    args.push(to);
    spawnSync('mail', args, { input: body });
    return 'mail';
  }
  if (has('sendmail')) {
    const headers = [from && `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '']
      .filter(Boolean)
      .join('\n');
    spawnSync('sendmail', ['-t'], { input: headers + '\n' + body });
    return 'sendmail';
  }
  process.stderr.write(`pulselog: no \`mail\`/\`sendmail\` on PATH; would alert ${to}: ${subject}\n`);
  return 'none';
}
