// Fallback alert sink (0.7.0) — a second, out-of-band delivery path so a dead MTA can't
// silence pulselog (the "circular alert" gap: the one alert that says "mail is broken"
// rides the same broken path and bounces). Opt-in via a `fallback` block on the alert-
// bearing config (health `alert`, `digest`, `backup`). Mechanism only: pulselog spawns the
// operator's command (ntfy/Slack/logger/SMS-CLI via `curl` etc.), body → stdin, subject →
// PULSELOG_SUBJECT env. Reuses the shared `spawnDelivery` primitive — no new spawn path.
import { spawnDelivery } from './deliver.js';
import { sendEmail } from './email.js';

/**
 * Validate + normalize a `fallback` config block. Returns the normalized shape, or `null`
 * when no fallback is configured. Throws on a malformed block — a fallback that cannot fire
 * is a configuration error, surfaced loudly (the CLI exits 1) rather than silently doing
 * nothing during the very incident it exists for.
 * @param {any} fallback
 * @returns {{ command: string, args: string[], when: 'always'|'on-primary-failure', timeoutMs: number } | null}
 */
export function normalizeFallback(fallback) {
  if (fallback == null) return null;
  const { command, args = [], when = 'always', timeoutMs = 10_000 } = fallback;
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('alert.fallback needs a non-empty string "command"');
  }
  if (!Array.isArray(args)) throw new Error('alert.fallback "args" must be an array');
  if (when !== 'always' && when !== 'on-primary-failure') {
    throw new Error(`alert.fallback "when" must be "always" or "on-primary-failure" (got "${when}")`);
  }
  const t = Math.floor(Number(timeoutMs));
  return { command, args, when, timeoutMs: Number.isFinite(t) && t > 0 ? t : 10_000 };
}

/**
 * Fire the fallback sink best-effort. Never throws and never affects the exit code — the
 * process may be reporting a failure already; a broken sink must not become a second one.
 * Body → the child's stdin, subject → `PULSELOG_SUBJECT`.
 * @param {{ command: string, args: string[], timeoutMs: number }} fb
 * @param {{ subject?: string, body?: string }} msg
 * @returns {{ attempted: true, ok: boolean, code: number|null, killed: boolean, err: string|null }}
 */
export function fireFallback(fb, { subject, body }) {
  try {
    const r = spawnDelivery(fb.command, fb.args, {
      input: body == null ? '' : String(body),
      env: { PULSELOG_SUBJECT: subject == null ? '' : String(subject) },
      timeoutMs: fb.timeoutMs,
    });
    return { attempted: true, ok: r.ok, code: r.code, killed: r.killed, err: r.err };
  } catch (err) {
    // spawnDelivery only throws on a malformed call, which normalizeFallback already ruled
    // out — but stay guarded so the best-effort contract holds no matter what.
    return { attempted: true, ok: false, code: null, killed: false, err: String((err && err.message) || err) };
  }
}

/**
 * Deliver one alert via the primary email (when `email` is set) and/or the fallback sink,
 * per the fallback's `when`. The fallback fires when: `when:"always"`, OR the primary
 * handoff failed, OR there is no primary at all (fallback-only box). Best-effort on the
 * fallback; the return reports each sink's outcome so the caller can record it (D5).
 * @param {{ email?: string, from?: string, subject: string, body: string,
 *   fb: {command:string,args:string[],when:string,timeoutMs:number}|null }} args
 * @returns {{ emailed: {transport:'mail'|'sendmail'|'none', ok:boolean}|null,
 *   fallback: {attempted:true, ok:boolean, code:number|null, killed:boolean, err:string|null}|null }}
 */
export function dispatchAlert({ email, from, subject, body, fb }) {
  const emailed = email ? sendEmail({ to: email, from, subject, body }) : null;
  let fallback = null;
  if (fb && (fb.when === 'always' || !emailed || !emailed.ok)) {
    fallback = fireFallback(fb, { subject, body });
  }
  return { emailed, fallback };
}
