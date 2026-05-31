// Backup mode tests — the envelope (stage → tar → atomic → floor → retention),
// the curated dump arg-builders, include semantics, and the CLI exit-code
// discipline (D15: a failed backup exits 1). sqlite cases run a real node:sqlite
// snapshot and skip cleanly if the runtime is older than 22.5. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
  rmSync, existsSync, symlinkSync, lstatSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup } from '../src/backup.js';
import { pgDumpArgs, mysqlDumpArgs, dbDest } from '../src/dumpers.js';

const BIN = fileURLToPath(new URL('../bin/pulselog.js', import.meta.url));

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Make a real sqlite db with `rows` rows, or return false if node:sqlite is absent.
async function makeDb(path, rows) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return false; }
  const db = new DatabaseSync(path);
  db.exec('create table t(x)');
  for (let i = 0; i < rows; i++) db.exec(`insert into t values(${i})`);
  db.close();
  return true;
}
async function countRows(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  const n = db.prepare('select count(*) c from t').get().c;
  db.close();
  return n;
}

function writeConfig(dir, backup) {
  const p = join(dir, 'backup.config.json');
  writeFileSync(p, JSON.stringify({ backup }, null, 2));
  return p;
}
function lastRecord(historyPath) {
  const lines = readFileSync(historyPath, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ── the envelope, end to end ─────────────────────────────────────────────────
test('backup: sqlite dump + include (dir w/ symlink + file) → archive, record, rows intact', async (t) => {
  const dir = tmp(t);
  const dbPath = join(dir, 'app.db');
  if (!(await makeDb(dbPath, 500))) { t.skip('node:sqlite unavailable (<22.5)'); return; }

  const conf = join(dir, 'conf'); mkdirSync(conf);
  writeFileSync(join(conf, 'app.conf'), 'key=val\n');
  const realCert = join(dir, 'archive-cert.pem'); writeFileSync(realCert, 'CERT\n');
  symlinkSync(realCert, join(conf, 'live-cert.pem')); // letsencrypt-style symlink

  const out = join(dir, 'backups');
  const history = join(dir, 'backup.jsonl');
  const cfg = writeConfig(dir, {
    app: 'app', dir: out, name: 'app-backup', history, keepLast: 7, minBytes: 100,
    db: [{ engine: 'sqlite', path: dbPath, name: 'app' }],
    include: [{ path: conf }],
  });

  const r = await runBackup({ configPath: cfg });
  assert.equal(r.status, 'ok');
  assert.ok(existsSync(r.archive) && r.bytes > 100);
  assert.ok(r.files >= 3); // app.db + app.conf + live-cert.pem

  const rec = lastRecord(history);
  assert.equal(rec.kind, 'backup');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.name, 'app-backup');
  assert.ok(typeof rec.bytes === 'number' && typeof rec.durationMs === 'number');

  // extract + verify the snapshot has every row and the symlink survived as a symlink
  const ex = join(dir, 'extract'); mkdirSync(ex);
  spawnSync('tar', ['-xzf', r.archive, '-C', ex]);
  assert.equal(await countRows(join(ex, 'app.db')), 500);
  assert.ok(lstatSync(join(ex, 'conf', 'live-cert.pem')).isSymbolicLink());
});

test('backup: required include missing → rejects, no archive written', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'backups');
  const cfg = writeConfig(dir, { dir: out, name: 'b', keepLast: 1, include: ['/no/such/path'] });
  await assert.rejects(runBackup({ configPath: cfg }), /required include path missing/);
  assert.ok(!existsSync(out) || readdirSync(out).filter((f) => f.endsWith('.tar.gz')).length === 0);
});

test('backup: optional include missing → skipped + recorded, run still ok', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'data'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const out = join(dir, 'backups');
  const history = join(dir, 'h.jsonl');
  const cfg = writeConfig(dir, {
    dir: out, name: 'b', keepLast: 1, history,
    include: [{ path: present }, { path: '/no/such', optional: true }],
  });
  const r = await runBackup({ configPath: cfg });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.skipped, ['/no/such']);
  assert.deepEqual(lastRecord(history).skipped, ['/no/such']);
});

test('backup: minBytes floor → rejects, no .tmp, and a prior good archive is NOT rotated away', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'data'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const out = join(dir, 'backups');
  // a prior good backup at T0
  const good = await runBackup({ configPath: writeConfig(dir, { dir: out, name: 'b', keepLast: 1, include: [present] }), now: 1_700_000_000_000 });
  assert.ok(existsSync(good.archive));
  const before = readdirSync(out).filter((f) => f.startsWith('b-')).length;

  // a later run that fails the floor (huge minBytes) at T1
  await assert.rejects(
    runBackup({ configPath: writeConfig(dir, { dir: out, name: 'b', keepLast: 1, minBytes: 1e12, include: [present] }), now: 1_700_000_005_000 }),
    /minBytes/,
  );
  assert.ok(!readdirSync(out).some((f) => f.endsWith('.tmp')), 'no .tmp left behind');
  assert.equal(readdirSync(out).filter((f) => f.startsWith('b-')).length, before, 'prior archive survived (no rotation on a failed run)');
});

test('backup: retention keepLast touches only own prefix, leaves foreign files alone', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'data'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const out = join(dir, 'backups'); mkdirSync(out, { recursive: true });
  // seed 3 older own-prefix archives + a foreign file + a non-archive file
  for (let i = 0; i < 3; i++) {
    const f = join(out, `roll-2026010${i}-000000.tar.gz`);
    writeFileSync(f, 'old'); const t0 = 1_600_000_000 + i; utimesSync(f, t0, t0);
  }
  writeFileSync(join(out, 'other-backup-20200101-000000.tar.gz'), 'foreign');
  writeFileSync(join(out, 'README.txt'), 'keep me');

  // a fresh backup with keepLast:2 — the new archive is newest, so exactly 2 own remain
  await runBackup({ configPath: writeConfig(dir, { dir: out, name: 'roll', keepLast: 2, include: [present] }), now: 1_700_000_000_000 });
  assert.equal(readdirSync(out).filter((f) => f.startsWith('roll-')).length, 2);
  assert.ok(existsSync(join(out, 'other-backup-20200101-000000.tar.gz')), 'foreign prefix untouched');
  assert.ok(existsSync(join(out, 'README.txt')), 'non-archive untouched');
});

test('backup: keepDays drops archives older than the window, keeps recent', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'data'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const out = join(dir, 'backups'); mkdirSync(out, { recursive: true });
  const now = 1_700_000_000_000;
  const old = join(out, 'k-20260101-000000.tar.gz'); writeFileSync(old, 'old');
  const oldT = (now - 40 * 86_400_000) / 1000; utimesSync(old, oldT, oldT); // 40 days old
  const recent = join(out, 'k-20260520-000000.tar.gz'); writeFileSync(recent, 'recent');
  const recT = (now - 2 * 86_400_000) / 1000; utimesSync(recent, recT, recT); // 2 days old

  await runBackup({ configPath: writeConfig(dir, { dir: out, name: 'k', keepDays: 30, include: [present] }), now });
  const remaining = readdirSync(out).filter((f) => f.startsWith('k-'));
  assert.ok(!remaining.includes('k-20260101-000000.tar.gz'), '40-day-old dropped');
  assert.ok(remaining.includes('k-20260520-000000.tar.gz'), '2-day-old kept');
});

// ── validation ───────────────────────────────────────────────────────────────
test('backup: no source (db|include|command) → rejects', async (t) => {
  const dir = tmp(t);
  const cfg = writeConfig(dir, { dir: join(dir, 'b'), name: 'b', keepLast: 1 });
  await assert.rejects(runBackup({ configPath: cfg }), /at least one source/);
});

test('backup: no retention rule → rejects', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'd'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const cfg = writeConfig(dir, { dir: join(dir, 'b'), name: 'b', include: [present] });
  await assert.rejects(runBackup({ configPath: cfg }), /keepLast.*keepDays|keepDays/);
});

// ── curated dump arg-builders (no server needed) ─────────────────────────────
test('dumpers: pg_dump uses -Fc custom format with url', () => {
  assert.deepEqual(pgDumpArgs({ url: 'postgres://u@/db', dest: '/s/db.dump' }), ['-Fc', '-f', '/s/db.dump', 'postgres://u@/db']);
});

test('dumpers: mysqldump encodes the --single-transaction consistency opinion + parses url', () => {
  const a = mysqlDumpArgs({ url: 'mysql://alice@db.host:3307/shop' });
  assert.ok(a.includes('--single-transaction'));
  assert.ok(a.includes('--quick') && a.includes('--routines') && a.includes('--triggers'));
  assert.deepEqual(a.slice(a.indexOf('--host')), ['--host', 'db.host', '--port', '3307', '--user', 'alice', '--databases', 'shop']);
});

test('dumpers: mysql url without a database name → throws', () => {
  assert.throws(() => mysqlDumpArgs({ url: 'mysql://u@host/' }), /no database/);
});

test('dumpers: dbDest names by engine + index or explicit name', () => {
  assert.equal(dbDest({ engine: 'sqlite' }, 0), 'sqlite-1.db');
  assert.equal(dbDest({ engine: 'postgres', name: 'main' }, 1), 'main.dump');
  assert.equal(dbDest({ engine: 'mysql' }, 2), 'mysql-3.sql');
});

// ── CLI exit-code discipline (D15) ───────────────────────────────────────────
test('cli: --backup exits 0 on success, 1 on a failed run (D15 loud)', async (t) => {
  const dir = tmp(t);
  const present = join(dir, 'd'); mkdirSync(present); writeFileSync(join(present, 'f'), 'x');
  const out = join(dir, 'b');

  const okCfg = writeConfig(dir, { dir: out, name: 'b', keepLast: 1, include: [present] });
  const okRun = spawnSync(process.execPath, [BIN, '--backup', '--config', okCfg], { encoding: 'utf8' });
  assert.equal(okRun.status, 0, okRun.stderr);

  const badCfg = join(dir, 'bad.json');
  writeFileSync(badCfg, JSON.stringify({ backup: { dir: out, name: 'b', keepLast: 1, include: ['/no/such/required'] } }));
  const badRun = spawnSync(process.execPath, [BIN, '--backup', '--config', badCfg], { encoding: 'utf8' });
  assert.equal(badRun.status, 1, 'a failed backup must exit 1');
  assert.match(badRun.stderr, /required include path missing/);
});
