// Backup orchestrator — one scheduled run. Stage the sources into a fresh
// $PULSELOG_STAGE (built-in db dumps → static includes → the command opt-out),
// tar → integrity floor → atomic publish → rolling retention → one
// kind:"backup" line. pulselog owns the envelope + the curated dumps (D12/D16);
// it stores only sizes/counts, never what's inside (§4 privacy). A failed run
// records + alerts and exits 1 (D15) — a silently-missing backup must never be
// quiet — and NEVER rotates, so a bad run can't delete a good prior archive.
import {
  readFileSync, mkdirSync, mkdtempSync, cpSync, existsSync, statSync,
  renameSync, rmSync, readdirSync, chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { createSink } from './sink.js';
import { sendEmail } from './email.js';
import { dumpDb, dbDest } from './dumpers.js';

const DAY_MS = 86_400_000;

/** Compact UTC stamp for the archive name: YYYYMMDD-HHMMSS. */
function utcStamp(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Count regular files under a dir (recursive) — the `files` field in the record. */
function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

/**
 * Rolling retention — among `<name>-*.tar.gz` in `dir` ONLY (never foreign
 * files), keep an archive if it's within the newest `keepLast` OR newer than
 * `keepDays` (union — a rule never deletes what another rule wants to keep).
 * @returns {number} how many archives remain.
 */
function rotate(dir, name, keepLast, keepDays, now) {
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.tar.gz'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m); // newest first
  const cutoff = keepDays ? now - keepDays * DAY_MS : null;
  const keep = new Set();
  mine.forEach((x, idx) => {
    const withinCount = keepLast ? idx < keepLast : false;
    const withinAge = cutoff != null ? x.m >= cutoff : false;
    if (withinCount || withinAge) keep.add(x.f);
  });
  for (const x of mine) if (!keep.has(x.f)) rmSync(join(dir, x.f), { force: true });
  return keep.size;
}

/**
 * Run the backup once.
 * @param {{ configPath: string, now?: number }} args
 * @returns {Promise<{ status: 'ok', bytes: number, files: number, kept: number,
 *   skipped: string[], archive: string }>}
 */
export async function runBackup({ configPath, now = Date.now() }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const b = config.backup;
  if (!b) throw new Error('config has no "backup" block');
  if (!b.dir || !b.name) throw new Error('backup needs "dir" and "name"');
  const dbs = b.db ? (Array.isArray(b.db) ? b.db : [b.db]) : [];
  const includes = (b.include || []).map((e) => (typeof e === 'string' ? { path: e } : e));
  if (!dbs.length && !includes.length && !b.command) {
    throw new Error('backup needs at least one source: "db", "include", or "command"');
  }
  if (!b.keepLast && !b.keepDays) throw new Error('backup needs "keepLast" and/or "keepDays"');

  const app = b.app || 'app';
  const ts = new Date(now).toISOString();
  const startedMs = now;
  /** @type {string[]} */
  const skipped = [];
  // Two sources that stage under the same name would silently overwrite each other
  // (one source lost from the backup). Claim each name; collide → fail loud.
  const used = new Set();
  const claim = (n) => {
    if (used.has(n)) throw new Error(`backup source collision: two sources stage as "${n}" — give one a distinct name/path`);
    used.add(n);
  };

  mkdirSync(b.dir, { recursive: true, mode: 0o700 }); // new dir owner-only (no-op if it already exists)
  const stage = mkdtempSync(join(b.dir, '.stage-')); // stage IN dir (a tmpfs /tmp can OOM on a big dump); mkdtemp is 0700

  try {
    // 1. built-in db dumps (safe defaults) → the stage
    for (let i = 0; i < dbs.length; i++) {
      const d = dbs[i];
      if (d.optional && d.engine === 'sqlite' && !existsSync(d.path)) { skipped.push(d.path); continue; }
      const destName = dbDest(d, i);
      claim(destName);
      await dumpDb(d, join(stage, destName));
    }

    // 2. static includes (symlinks preserved); required missing → fail loud, optional → skip+record
    for (const inc of includes) {
      if (!existsSync(inc.path)) {
        if (inc.optional) { skipped.push(inc.path); continue; }
        throw new Error(`required include path missing: ${inc.path}`);
      }
      const name = basename(inc.path);
      claim(name);
      cpSync(inc.path, join(stage, name), { recursive: true, verbatimSymlinks: true });
    }

    // 3. command opt-out — the adopter's dump writes into $PULSELOG_STAGE
    if (b.command) {
      const r = spawnSync(b.command, b.args || [], {
        env: { ...process.env, PULSELOG_STAGE: stage },
        timeout: b.timeoutMs || 0,
        encoding: 'utf8',
      });
      if (r.error) throw new Error(`backup command failed to start: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`backup command exited ${r.status}: ${(r.stderr || '').trim()}`);
    }

    // 4. tar → integrity floor → atomic publish (a partial tar never gets the canonical name)
    const archive = join(b.dir, `${b.name}-${utcStamp(now)}.tar.gz`);
    const tmp = `${archive}.tmp`;
    const tarRes = spawnSync('tar', ['-czf', tmp, '-C', stage, '.'], { encoding: 'utf8' });
    if (tarRes.status !== 0) { rmSync(tmp, { force: true }); throw new Error(`tar failed: ${(tarRes.stderr || '').trim()}`); }
    chmodSync(tmp, 0o600); // the archive holds DB dumps + private keys (certs/DKIM) — owner-only, never group/world-readable
    const bytes = statSync(tmp).size;
    if (b.minBytes && bytes < b.minBytes) {
      rmSync(tmp, { force: true });
      throw new Error(`archive ${bytes}B < minBytes ${b.minBytes} — not published, not rotated`);
    }
    const files = countFiles(stage);
    renameSync(tmp, archive); // atomic publish

    // 5. retention — ONLY after a good archive is on disk (a failed run above never reaches here)
    const kept = rotate(b.dir, b.name, b.keepLast, b.keepDays, now);

    // 6. record one kind:"backup" line (its own file). Success is otherwise silent.
    const record = { ts, kind: 'backup', app, name: b.name, status: 'ok', bytes, files, durationMs: Date.now() - startedMs, kept, skipped };
    if (b.history) createSink({ file: b.history, maxBytes: 0 }).emit(record);
    return { status: 'ok', bytes, files, kept, skipped, archive };
  } catch (err) {
    // Record + alert the failure, then rethrow so the CLI exits 1 (D15).
    const record = { ts, kind: 'backup', app, name: b.name, status: 'fail', message: err.message, skipped };
    if (b.history) { try { createSink({ file: b.history, maxBytes: 0 }).emit(record); } catch { /* never mask the real error */ } }
    if (b.email) { try { sendEmail({ to: b.email, from: b.from, subject: `[${app}] backup FAILED — ${b.name}`, body: `${err.message}\n` }); } catch { /* same */ } }
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
