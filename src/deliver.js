// One subprocess-delivery primitive, shared by the email transports (`mail`/`sendmail`)
// and — from 0.7.0 — the fallback alert sink. The single idea both need: "spawn a
// delivery command, pipe the rendered body to its stdin, best-effort." This unifies
// email.js's `spawnSync({ input })` with backup.js's env+timeout so there is ONE place
// that knows how a body is handed to a child, no shell.
//
// `spawnSync` does NOT throw for the cases that matter operationally — a non-zero exit, a
// missing binary (ENOENT), or a timeout kill are all reported via `.status`/`.error`/
// `.signal`. This normalizes those three into a uniform result. It CAN still throw on a
// *malformed call* (e.g. a non-string command from a bad config); callers that spawn from
// config validate the shape up front and/or guard best-effort (the fallback sink), so this
// helper stays a thin, honest wrapper rather than swallowing programmer errors silently.
import { spawnSync } from 'node:child_process';

/**
 * Spawn `command` with `args` (never via a shell), piping `input` to the child's stdin and
 * merging `env` over the current environment. The child is killed past `timeoutMs`. Never
 * rejects; reports outcome as a plain object.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ input?: string, env?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, code: number | null, killed: boolean, err: string | null }}
 *   `ok` true only on a clean exit 0. `code` is the exit code (null if killed/failed to
 *   start). `killed` true when a timeout terminated it. `err` is the errno/message when the
 *   spawn itself failed (e.g. `'ENOENT'`), else null.
 */
export function spawnDelivery(command, args = [], { input = '', env, timeoutMs } = {}) {
  const r = spawnSync(command, args, {
    input,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs || undefined,
    windowsHide: true,
    encoding: 'utf8',
  });
  const e = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  return {
    ok: !e && r.status === 0,
    code: typeof r.status === 'number' ? r.status : null,
    killed: Boolean(e && (e.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')),
    err: e ? (e.code || e.message) : null,
  };
}
