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
//
// 0.8.0: the child is spawned `detached` (its own process group) and, on a timeout, the
// whole group is SIGKILLed. spawnSync's own timeout signals only the direct child — but
// `mail`/`sendmail` hand off to a `postdrop` grandchild, which in the addypin incident kept
// retrying forever after its parent was gone. Killing `-pid` takes the grandchild with it.
// Limitation: Node can't run a signal handler while spawnSync blocks, so if pulselog itself
// is SIGINT/SIGTERMed mid-send the group is orphaned (under systemd the cgroup kill on
// stop/timeout still reaps it; under cron/interactive it runs until it exits on its own).
import { spawnSync } from 'node:child_process';

/**
 * Spawn `command` with `args` (never via a shell), piping `input` to the child's stdin and
 * merging `env` over the current environment. The child is killed past `timeoutMs`. Never
 * rejects; reports outcome as a plain object.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ input?: string, env?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, code: number | null, killed: boolean, err: string | null, reason: string | null }}
 *   `ok` true only on a clean exit 0. `code` is the exit code (null if killed/failed to
 *   start). `killed` true when a timeout terminated it. `err` is the errno/message when the
 *   spawn itself failed (e.g. `'ENOENT'`), else null. `reason` is the one-word cause for
 *   records and logs — `'timeout'`, `'exit N'`, the errno, or a signal name — null when ok.
 */
export function spawnDelivery(command, args = [], { input = '', env, timeoutMs } = {}) {
  // `detached` is honored by spawnSync (passed through to libuv → setsid) though only
  // documented for spawn; the group-kill test in deliver.test.js guards it.
  const r = spawnSync(command, args, /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */ ({
    input,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs || undefined,
    windowsHide: true,
    encoding: 'utf8',
    detached: true, // own process group, so a timeout can kill grandchildren too
  }));
  let e = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  // A child that exits without reading stdin makes spawnSync report EPIPE even though it ran
  // and exited — judge it by its exit status, not by the unread pipe.
  if (e && e.code === 'EPIPE' && typeof r.status === 'number') e = undefined;
  const killed = Boolean(e && (e.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'));
  if (killed && r.pid) {
    try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  const ok = !e && r.status === 0;
  const code = typeof r.status === 'number' ? r.status : null;
  const err = e ? (e.code || e.message) : null;
  const reason = ok ? null : killed ? 'timeout' : err || (code != null ? `exit ${code}` : r.signal || 'failed');
  return { ok, code, killed, err, reason };
}
