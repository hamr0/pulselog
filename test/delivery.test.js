// 0.8.0 delivery-outcome tests — the addypin incident: a sandboxed unit's MTA handoff hung
// (postdrop looping on EACCES), the fallback never fired, the digest reported "→ mail", and
// stats.jsonl looked normal for ~3 months. Each test drives a real fake `mail` on PATH and
// reads the evidence back off disk / the exit code. Every "fails" case has a sibling
// "delivers" case under the same config family, so a gate that always says one thing fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWeeks } from '../src/metrics.js';
import { runDigest } from '../src/digest.js';
import { run } from '../src/run.js';
import { runBackup } from '../src/backup.js';

const BIN = fileURLToPath(new URL('../bin/pulselog.js', import.meta.url));
const ANCHOR = Date.parse('2026-05-31T12:00:00Z'); // a Sunday, ISO 2026-W22

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pulselog-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function shadowPath(t, dir) {
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  t.after(() => { process.env.PATH = orig; });
}
/** Fake `mail`: 'hang' blocks like the sandboxed postdrop; a number exits with that code. */
function fakeMail(dir, mode) {
  const body = mode === 'hang' ? 'cat >/dev/null\nsleep 30 &\nwait\n' : `cat >/dev/null\nexit ${mode}\n`;
  writeFileSync(join(dir, 'mail'), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, 'mail'), 0o755);
}
function writeCfg(dir, cfg) {
  const p = join(dir, 'cfg.json');
  writeFileSync(p, JSON.stringify(cfg));
  chmodSync(p, 0o600);
  return p;
}
const lines = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cli = (dir, args) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
});
const FAIL_FB = { command: 'sh', args: ['-c', 'exit 3'], when: 'on-primary-failure' };
const OK_FB = { command: 'sh', args: ['-c', 'cat >/dev/null'], when: 'on-primary-failure' };
// mailTimeoutMs only where a hang is intended (HANG_MS); a fake mail that should finish gets the 30s default.
const HANG_MS = 300;
const digestCfg = (dir, fallback, mailTimeoutMs) => ({ digest: {
  app: 'demo', history: join(dir, 'stats.jsonl'), email: 'ops@x', mailTimeoutMs,
  metrics: [{ name: 'users', command: 'echo', args: ['42'] }], fallback,
} });

// ── loadWeeks ignores non-snapshot rows (so the delivery line can share the history) ────
test('loadWeeks: a later kind:"delivery" row does not replace the week\'s stats row', () => {
  const jsonl = [
    { ts: '2026-05-31T12:00:00Z', kind: 'stats', app: 'a', users: 42 },
    { ts: '2026-05-31T12:00:01Z', kind: 'delivery', app: 'a', status: 'fail' },
    { ts: '2026-05-24T12:00:00Z', app: 'a', users: 40 }, // legacy row with no kind — still a snapshot
  ].map((r) => JSON.stringify(r)).join('\n');
  const weeks = loadWeeks(jsonl);
  assert.deepEqual(weeks.map((w) => [w.week, w.users]), [['2026-W21', 40], ['2026-W22', 42]]);
});

// ── digest: durable delivery record + honest result ─────────────────────────────────────
test('digest: hung primary + failing fallback → durable fail record with both reasons', (t) => {
  const dir = tmp(t); fakeMail(dir, 'hang'); shadowPath(t, dir);
  const res = runDigest({ configPath: writeCfg(dir, digestCfg(dir, FAIL_FB, HANG_MS)), now: ANCHOR });
  assert.equal(res.deliveryFailed, true);
  assert.equal(res.delivered, 'mail:fail(timeout), fallback:fail(exit 3)');
  const [snap, rec] = lines(join(dir, 'stats.jsonl'));
  assert.equal(snap.kind, 'stats', 'the snapshot is still written first');
  assert.equal(snap.users, 42);
  assert.deepEqual(rec, {
    ts: rec.ts, kind: 'delivery', app: 'demo', week: '2026-W22', status: 'fail',
    emailed: { transport: 'mail', ok: false, reason: 'timeout' },
    fallback: { ok: false, reason: 'exit 3' },
  });
});
test('digest: failed primary but fallback delivers → status ok, not a delivery failure', (t) => {
  const dir = tmp(t); fakeMail(dir, 75); shadowPath(t, dir);
  const res = runDigest({ configPath: writeCfg(dir, digestCfg(dir, OK_FB)), now: ANCHOR });
  assert.equal(res.deliveryFailed, false);
  assert.equal(res.delivered, 'mail:fail(exit 75), fallback');
  const rec = lines(join(dir, 'stats.jsonl'))[1];
  assert.equal(rec.status, 'ok');
  assert.deepEqual(rec.fallback, { ok: true });
});
test('digest: clean handoff keeps the plain "mail" result (no fallback attempted)', (t) => {
  const dir = tmp(t); fakeMail(dir, 0); shadowPath(t, dir);
  const res = runDigest({ configPath: writeCfg(dir, digestCfg(dir, OK_FB)), now: ANCHOR });
  assert.equal(res.delivered, 'mail');
  assert.equal(res.deliveryFailed, false);
  assert.deepEqual(lines(join(dir, 'stats.jsonl'))[1].emailed, { transport: 'mail', ok: true });
});

// ── CLI exit code: 1 only when delivery was attempted and every path failed ─────────────
test('CLI digest: exit 1 when all delivery paths fail; exit 0 when the fallback delivers', (t) => {
  const dir = tmp(t); fakeMail(dir, 75);
  const bad = cli(dir, ['--digest', '--config', writeCfg(dir, digestCfg(dir, FAIL_FB))]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /→ mail:fail\(exit 75\), fallback:fail\(exit 3\)/);
  const good = cli(dir, ['--digest', '--config', writeCfg(dir, digestCfg(dir, OK_FB))]);
  assert.equal(good.status, 0, good.stderr);
});
test('CLI digest: no email + no fallback stays exit 0 (nothing was attempted)', (t) => {
  const dir = tmp(t);
  const cfg = digestCfg(dir, undefined); delete cfg.digest.email;
  const r = cli(dir, ['--digest', '--config', writeCfg(dir, cfg)]);
  assert.equal(r.status, 0, r.stderr);
});

// ── health: same rule, reasons in the D5 record ──────────────────────────────────────────
const healthCfg = (dir, fallback, mailTimeoutMs) => ({
  output: { file: join(dir, 'health.jsonl'), maxBytes: 0 },
  checks: [{ type: 'command', name: 'svc', command: 'false' }],
  alert: { app: 'demo', email: 'ops@x', mailTimeoutMs, fallback },
});
test('health: hung primary + failing fallback → deliveryFailed, reasons in the alert record', async (t) => {
  const dir = tmp(t); fakeMail(dir, 'hang'); shadowPath(t, dir);
  const res = await run({ configPath: writeCfg(dir, healthCfg(dir, FAIL_FB, HANG_MS)) });
  assert.deepEqual(res, { total: 1, failures: 1, deliveryFailed: true });
  const alert = lines(join(dir, 'health.jsonl')).find((r) => r.kind === 'alert');
  assert.equal(alert.status, 'fail');
  assert.deepEqual(alert.emailed, { transport: 'mail', ok: false, reason: 'timeout' });
  assert.deepEqual(alert.fallback, { ok: false, reason: 'exit 3' });
});
test('CLI health: exit 1 when the alert cannot be delivered; 0 when it can; 0 on green', (t) => {
  const dir = tmp(t); fakeMail(dir, 75);
  assert.equal(cli(dir, ['--config', writeCfg(dir, healthCfg(dir, FAIL_FB))]).status, 1);
  assert.equal(cli(dir, ['--config', writeCfg(dir, healthCfg(dir, OK_FB))]).status, 0);
  const green = healthCfg(dir, FAIL_FB); green.checks[0].command = 'true';
  assert.equal(cli(dir, ['--config', writeCfg(dir, green)]).status, 0, 'silent on green: no send attempted');
});

// ── backup: failure record carries the primary outcome + reasons too ────────────────────
test('backup: a failed run records emailed + fallback with reasons', async (t) => {
  const dir = tmp(t); fakeMail(dir, 'hang'); shadowPath(t, dir);
  const history = join(dir, 'backup.jsonl');
  const cfg = writeCfg(dir, { backup: {
    app: 'demo', name: 'b', dir: join(dir, 'out'), history, email: 'ops@x', mailTimeoutMs: HANG_MS, keepLast: 3,
    include: [{ path: join(dir, 'missing') }], fallback: FAIL_FB,
  } });
  await assert.rejects(runBackup({ configPath: cfg }), /required include path missing/);
  const rec = lines(history).at(-1);
  assert.equal(rec.status, 'fail');
  assert.deepEqual(rec.emailed, { transport: 'mail', ok: false, reason: 'timeout' });
  assert.deepEqual(rec.fallback, { ok: false, reason: 'exit 3' });
});

// ── --test-alert: prove both paths before they're needed ─────────────────────────────────
// Fake fallback that records that it fired (and what subject it got), so "ran" is observable.
function recFb(dir, when) {
  const fired = join(dir, 'fb.fired');
  return { fired, fb: { command: 'sh', args: ['-c', `cat >/dev/null; echo "$PULSELOG_SUBJECT" > ${fired}`], when } };
}
const testCfg = (dir, mode, block) => ({
  output: { file: join(dir, 'health.jsonl'), maxBytes: 0 }, checks: [],
  ...(mode === 'health' ? { alert: { app: 'demo', ...block } }
    : mode === 'digest' ? { digest: { app: 'demo', history: join(dir, 'stats.jsonl'), metrics: [], ...block } }
    : { backup: { app: 'demo', name: 'b', dir: join(dir, 'out'), history: join(dir, 'backup.jsonl'), include: [], ...block } }),
});
const jsonlFiles = (dir) => ['health.jsonl', 'stats.jsonl', 'backup.jsonl'].filter((f) => existsSync(join(dir, f)));

test('CLI --test-alert: both paths ok → exit 0, each path printed, fallback fires despite when', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  const { fired, fb } = recFb(dir, 'on-primary-failure'); // `when` must be ignored
  const r = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x', fallback: fb }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /primary \(mail\): ok, queued, not proof of delivery/);
  assert.match(r.stdout, /fallback: ok/);
  assert.match(readFileSync(fired, 'utf8'), /^\[demo\] pulselog test alert \(health\) on \S+/);
  assert.deepEqual(jsonlFiles(dir), [], 'writes nothing to any JSONL');
});
test('CLI --test-alert: hung primary → exit 1, "primary: fail (timeout)", fallback still ok', (t) => {
  const dir = tmp(t); fakeMail(dir, 'hang');
  const { fb } = recFb(dir, 'always');
  const r = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x', mailTimeoutMs: HANG_MS, fallback: fb }))]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /primary: fail \(timeout\)/);
  assert.match(r.stdout, /fallback: ok/);
});
test('CLI --test-alert: failing fallback → exit 1 with its reason; primary-only is exit 0', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  const bad = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x', fallback: FAIL_FB }))]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /fallback: fail \(exit 3\)/);
  const ok = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x' }))]);
  assert.equal(ok.status, 0, 'a missing fallback is not a failure');
  assert.match(ok.stdout, /fallback: not configured/);
});
test('CLI --test-alert: --digest and --backup together → usage error, exit 1, nothing sent', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  const { fired, fb } = recFb(dir, 'always');
  const cfg = writeCfg(dir, { ...testCfg(dir, 'digest', { email: 'ops@x', fallback: fb }), ...testCfg(dir, 'backup', { email: 'ops@x', fallback: fb }) });
  const both = cli(dir, ['--test-alert', '--digest', '--backup', '--config', cfg]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--test-alert takes one of --digest or --backup/);
  assert.equal(existsSync(fired), false, 'neither path was exercised');
  assert.equal(cli(dir, ['--test-alert', '--backup', '--config', cfg]).status, 0, 'one flag alone still works');
});
test('CLI --test-alert: fallback-only box works; neither path configured → exit 1', (t) => {
  const dir = tmp(t);
  const only = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { fallback: OK_FB }))]);
  assert.equal(only.status, 0, only.stderr);
  assert.match(only.stdout, /primary: not configured/);
  assert.match(only.stdout, /fallback: ok/);
  const none = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', {}))]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /primary: not configured/);
});
test('CLI --test-alert: --digest / --backup test that block, subject names the mode', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  for (const [flag, mode] of [['--digest', 'digest'], ['--backup', 'backup']]) {
    const { fired, fb } = recFb(dir, 'on-primary-failure');
    const r = cli(dir, ['--test-alert', flag, '--config', writeCfg(dir, testCfg(dir, mode, { email: 'ops@x', fallback: fb }))]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(fired, 'utf8'), new RegExp(`pulselog test alert \\(${mode}\\)`));
    assert.deepEqual(jsonlFiles(dir), []);
  }
  // the digest block's broken fallback must not be masked by a healthy health alert block
  const cfg = testCfg(dir, 'digest', { email: 'ops@x', fallback: FAIL_FB });
  cfg.alert = { app: 'demo', email: 'ops@x' };
  assert.equal(cli(dir, ['--test-alert', '--digest', '--config', writeCfg(dir, cfg)]).status, 1);
});
test('CLI --test-alert: malformed fallback → loud error, exit 1', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  const r = cli(dir, ['--test-alert', '--config', writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x', fallback: { args: [] } }))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a non-empty string "command"/);
});
test('CLI --test-alert: still refuses a group-writable config', (t) => {
  const dir = tmp(t); fakeMail(dir, 0);
  const p = writeCfg(dir, testCfg(dir, 'health', { email: 'ops@x' }));
  chmodSync(p, 0o666);
  const r = cli(dir, ['--test-alert', '--config', p]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing/);
});
