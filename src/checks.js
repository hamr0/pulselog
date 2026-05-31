// Health-check primitives. Each is `async (cfg) => { ok, reason, detail? }` and
// must NEVER throw — it returns a structured failure instead (the runner guards
// too, but a check owning its own failure path keeps reasons specific). Zero deps:
// node: builtins + global `fetch`. pulselog owns the *shape* (probe → result);
// the adopter owns *which* checks, via config. `command` is the escape hatch for
// anything not covered here (pg_isready, mailq, a custom script).
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const secs = (ms) => Math.round(ms / 1000);

/** Run a command; resolve { code, stdout, stderr, killed } — never reject. */
const exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        killed: Boolean(err && err.killed),
      });
    });
  });

/** An HTTP(S) endpoint returns the expected status. */
export async function http(cfg) {
  const { url, expectStatus = 200, timeoutMs = 5000 } = cfg;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const ok = res.status === expectStatus;
    return {
      ok,
      reason: ok ? `HTTP ${res.status}` : `HTTP ${res.status}, expected ${expectStatus}`,
      detail: { http_status: res.status }, // not `status` — that's the record's ok/fail field
    };
  } catch (err) {
    return { ok: false, reason: `unreachable: ${err.code || err.name || err.message}`, detail: { http_status: 0 } };
  }
}

/** A host:port accepts a TCP connection — reachability for a DB/queue/etc. */
export function tcp(cfg) {
  const { host, port, timeoutMs = 5000 } = cfg;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, `connected ${host}:${port}`));
    socket.once('timeout', () => finish(false, `timeout after ${secs(timeoutMs)}s connecting ${host}:${port}`));
    socket.once('error', (/** @type {NodeJS.ErrnoException} */ err) => finish(false, `${err.code || err.message} connecting ${host}:${port}`));
  });
}

/** A TLS certificate is not within `warnDays` of expiry. */
export function ssl(cfg) {
  const { host, port = 443, warnDays = 14, timeoutMs = 5000 } = cfg;
  return new Promise((resolve) => {
    // rejectUnauthorized:false so we can still read (and report on) an expired or
    // self-signed cert rather than erroring out before inspecting it.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    let done = false;
    const finish = (ok, reason, detail) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, reason, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish(false, `no certificate from ${host}:${port}`);
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      const ok = days >= warnDays;
      finish(ok, ok ? `cert valid ${days}d` : `cert expires in ${days}d (warn <${warnDays}d)`, { daysUntilExpiry: days });
    });
    socket.once('timeout', () => finish(false, `timeout after ${secs(timeoutMs)}s (TLS ${host}:${port})`));
    socket.once('error', (err) => finish(false, `${err.code || err.message} (TLS ${host}:${port})`));
  });
}

/** A filesystem path is below a usage threshold (parsed from `df -Pk`). */
export async function disk(cfg) {
  const { path = '/', maxPercent = 85 } = cfg;
  const { code, stdout } = await exec('df', ['-Pk', path], 5000);
  if (code !== 0) return { ok: false, reason: `df failed for ${path}` };
  const last = stdout.trim().split('\n').pop() || '';
  const pct = Number((last.match(/(\d+)%/) || [])[1]);
  if (Number.isNaN(pct)) return { ok: false, reason: `could not parse df for ${path}` };
  const ok = pct < maxPercent;
  return { ok, reason: ok ? `disk ${pct}% used` : `disk ${pct}% used (max ${maxPercent}%)`, detail: { percent: pct } };
}

/** The newest file in a dir (or a single file) is fresh — proves backups ran. */
export async function fileAge(cfg) {
  const { path, maxAgeHours, pattern } = cfg;
  try {
    const st = await stat(path);
    let newest;
    if (st.isDirectory()) {
      const names = (await readdir(path)).filter((n) => !pattern || n.includes(pattern));
      if (names.length === 0) return { ok: false, reason: `no files${pattern ? ` matching "${pattern}"` : ''} in ${path}` };
      const times = await Promise.all(names.map(async (n) => (await stat(join(path, n))).mtimeMs));
      newest = Math.max(...times);
    } else {
      newest = st.mtimeMs;
    }
    const ageH = (Date.now() - newest) / 3_600_000;
    const ok = ageH <= maxAgeHours;
    return {
      ok,
      reason: ok ? `newest ${ageH.toFixed(1)}h old` : `stale: newest ${ageH.toFixed(1)}h old (max ${maxAgeHours}h)`,
      detail: { ageHours: Number(ageH.toFixed(1)) },
    };
  } catch (err) {
    return { ok: false, reason: `${err.code || err.message} for ${path}` };
  }
}

/** A systemd unit is active (`systemctl is-active`). */
export async function service(cfg) {
  const { unit } = cfg;
  const { code, stdout } = await exec('systemctl', ['is-active', unit], 5000);
  const state = stdout.trim() || 'unknown';
  const ok = code === 0 && state === 'active';
  return { ok, reason: ok ? `${unit} active` : `${unit} ${state}`, detail: { state } };
}

/** Escape hatch: any command that exits 0 is healthy. */
export async function command(cfg) {
  const { command: cmd, args = [], timeoutMs = 10_000 } = cfg;
  const { code, stderr, killed } = await exec(cmd, args, timeoutMs);
  const ok = code === 0;
  const tail = stderr.trim().slice(0, 200);
  return { ok, reason: ok ? 'exit 0' : `exit ${code}${killed ? ' (timeout)' : ''}${tail ? ': ' + tail : ''}` };
}

/** type → check function. Config `type` keys map here. */
export const CHECKS = { http, tcp, ssl, disk, 'file-age': fileAge, service, command };
