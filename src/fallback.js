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
 * @returns {{ attempted: true, ok: boolean, code: number|null, killed: boolean, err: string|null, reason: string|null }}
 */
export function fireFallback(fb, { subject, body }) {
  try {
    const r = spawnDelivery(fb.command, fb.args, {
      input: body == null ? '' : String(body),
      env: { PULSELOG_SUBJECT: subject == null ? '' : String(subject) },
      timeoutMs: fb.timeoutMs,
    });
    return { attempted: true, ok: r.ok, code: r.code, killed: r.killed, err: r.err, reason: r.reason };
  } catch (err) {
    // spawnDelivery only throws on a malformed call, which normalizeFallback already ruled
    // out — but stay guarded so the best-effort contract holds no matter what.
    const msg = String((err && err.message) || err);
    return { attempted: true, ok: false, code: null, killed: false, err: msg, reason: msg };
  }
}

/**
 * Deliver one alert via the primary email (when `email` is set) and/or the fallback sink,
 * per the fallback's `when`. The fallback fires when: `when:"always"`, OR the primary
 * handoff failed, OR there is no primary at all (fallback-only box). Best-effort on the
 * fallback; the return reports each sink's outcome so the caller can record it (D5).
 * `timeoutMs` bounds the primary handoff (0.8.0) — a hang counts as a primary failure.
 * @param {{ email?: string, from?: string, subject: string, body: string, timeoutMs?: number,
 *   fb: {command:string,args:string[],when:string,timeoutMs:number}|null }} args
 * @returns {{ emailed: {transport:'mail'|'sendmail'|'none', ok:boolean, reason:string|null}|null,
 *   fallback: {attempted:true, ok:boolean, code:number|null, killed:boolean, err:string|null, reason:string|null}|null }}
 */
export function dispatchAlert({ email, from, subject, body, fb, timeoutMs }) {
  const emailed = email ? sendEmail({ to: email, from, subject, body, timeoutMs }) : null;
  let fallback = null;
  if (fb && (fb.when === 'always' || !emailed || !emailed.ok)) {
    fallback = fireFallback(fb, { subject, body });
  }
  return { emailed, fallback };
}

/**
 * The durable shape of one delivery attempt (D5), shared by health / digest / backup so
 * "emailed: fail (timeout), fallback: fail (exit 3)" survives in the JSONL even after the
 * journal rotates (the addypin incident left no trace anywhere else). `status` is `'fail'`
 * only when something was attempted and every attempted path failed.
 * @param {ReturnType<typeof dispatchAlert>} out
 * @returns {{ status: 'ok'|'fail', emailed: {transport:string, ok:boolean, reason?:string}|null,
 *   fallback: {ok:boolean, reason?:string, err?:string}|null }}
 */
export function deliveryRecord({ emailed, fallback }) {
  return {
    status: deliveryFailed({ emailed, fallback }) ? 'fail' : 'ok',
    emailed: emailed ? { transport: emailed.transport, ok: emailed.ok, ...(emailed.reason ? { reason: emailed.reason } : {}) } : null,
    fallback: fallback
      ? { ok: fallback.ok, ...(fallback.reason ? { reason: fallback.reason } : {}),
          ...(fallback.err ? { err: fallback.err } : {}) } // `err` kept: the pre-0.8.0 record field
      : null,
  };
}

/**
 * True when delivery was attempted and every attempted path failed — the one case where
 * the alert itself is what broke, so the CLI exits 1 (0.8.0) instead of staying silent.
 * @param {ReturnType<typeof dispatchAlert>} out
 */
export function deliveryFailed({ emailed, fallback }) {
  return Boolean(emailed || fallback) && !(emailed && emailed.ok) && !(fallback && fallback.ok);
}

/**
 * One-line human summary for stderr: `mail`, `mail:fail(timeout), fallback`, … A clean
 * primary-only send reads exactly as before 0.8.0 (`mail`).
 * @param {ReturnType<typeof dispatchAlert>} out
 */
export function describeDelivery({ emailed, fallback }) {
  const part = (name, r) => (r.ok ? name : `${name}:fail(${r.reason || 'failed'})`);
  return [emailed && part(emailed.transport, emailed), fallback && part('fallback', fallback)]
    .filter(Boolean).join(', ') || 'none';
}
