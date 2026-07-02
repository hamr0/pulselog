// Fallback alert sink — behavior tests with real child processes and real files.
// The when-gate is validated by exercising BOTH outcomes (fires / does-not-fire) under
// the same config family, so a broken gate can't pass. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeFallback, fireFallback, dispatchAlert } from '../src/fallback.js';
import { run } from '../src/run.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function shadowPath(t, dir) {
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  t.after(() => { process.env.PATH = orig; });
}
/** A fallback sink script that records that it fired + its stdin + PULSELOG_SUBJECT. */
function fbSink(dir) {
  const fired = join(dir, 'fired'); const body = join(dir, 'body'); const subj = join(dir, 'subj');
  const p = join(dir, 'sink.sh');
  writeFileSync(p, `#!/bin/sh\ntouch "${fired}"\ncat > "${body}"\nprintf %s "$PULSELOG_SUBJECT" > "${subj}"\n`);
  chmodSync(p, 0o755);
  return { command: p, fired, body, subj };
}
/** A fake `mail` on PATH that consumes stdin and exits `code` (control the primary). */
function fakeMail(dir, code) {
  writeFileSync(join(dir, 'mail'), `#!/bin/sh\ncat >/dev/null\nexit ${code}\n`);
  chmodSync(join(dir, 'mail'), 0o755);
}

// ── normalizeFallback: loud on a malformed block (config error → exit 1) ────────────────
test('normalizeFallback: absent → null; valid → defaults (when=always, timeoutMs=10000)', () => {
  assert.equal(normalizeFallback(undefined), null);
  assert.deepEqual(normalizeFallback({ command: 'curl' }), { command: 'curl', args: [], when: 'always', timeoutMs: 10_000 });
});
test('normalizeFallback: rejects a fallback that cannot fire', () => {
  assert.throws(() => normalizeFallback({ args: ['x'] }), /non-empty string "command"/);
  assert.throws(() => normalizeFallback({ command: '  ' }), /non-empty string "command"/);
  assert.throws(() => normalizeFallback({ command: 'curl', args: 'nope' }), /"args" must be an array/);
  assert.throws(() => normalizeFallback({ command: 'curl', when: 'sometimes' }), /"when" must be/);
});

// ── the when-gate: BOTH branches, same config family ────────────────────────────────────
test('dispatchAlert: on-primary-failure FIRES when the primary handoff fails', (t) => {
  const dir = tmp(t); const sink = fbSink(dir); fakeMail(dir, 1); shadowPath(t, dir);
  const fb = normalizeFallback({ command: sink.command, when: 'on-primary-failure' });
  const out = dispatchAlert({ email: 'ops@x', subject: 'S', body: 'B', fb });
  assert.equal(out.emailed.ok, false, 'primary handoff failed');
  assert.equal(existsSync(sink.fired), true, 'fallback fired');
  assert.equal(out.fallback.ok, true);
});
test('dispatchAlert: on-primary-failure does NOT fire when the primary succeeds', (t) => {
  const dir = tmp(t); const sink = fbSink(dir); fakeMail(dir, 0); shadowPath(t, dir);
  const fb = normalizeFallback({ command: sink.command, when: 'on-primary-failure' });
  const out = dispatchAlert({ email: 'ops@x', subject: 'S', body: 'B', fb });
  assert.equal(out.emailed.ok, true, 'primary handoff ok');
  assert.equal(existsSync(sink.fired), false, 'fallback correctly NOT fired');
  assert.equal(out.fallback, null);
});
test('dispatchAlert: when=always fires even when the primary succeeds', (t) => {
  const dir = tmp(t); const sink = fbSink(dir); fakeMail(dir, 0); shadowPath(t, dir);
  const fb = normalizeFallback({ command: sink.command, when: 'always' });
  const out = dispatchAlert({ email: 'ops@x', subject: 'S', body: 'B', fb });
  assert.equal(out.emailed.ok, true);
  assert.equal(existsSync(sink.fired), true, 'always → fires regardless');
});

// ── fallback-only (no MTA), payload wiring, privacy pass-through ─────────────────────────
test('dispatchAlert: fallback-only (no email) delivers, body→stdin & PULSELOG_SUBJECT set', (t) => {
  const dir = tmp(t); const sink = fbSink(dir);
  const BODY = 'flightlog (last 7d): 31 errors. top: ApiTimeout×24.\n'; // redacted digest render (counts+names only)
  const fb = normalizeFallback({ command: sink.command });
  const out = dispatchAlert({ subject: '[app] weekly', body: BODY, fb });
  assert.equal(out.emailed, null, 'no primary configured');
  assert.equal(out.fallback.ok, true);
  assert.equal(readFileSync(sink.body, 'utf8'), BODY, 'body reaches stdin byte-exact (carries the redacted render)');
  assert.equal(readFileSync(sink.subj, 'utf8'), '[app] weekly', 'PULSELOG_SUBJECT set');
});

// ── best-effort: a broken sink never throws, reports ok:false ────────────────────────────
test('fireFallback: a failing sink is swallowed (ok:false, no throw)', () => {
  const nonzero = fireFallback({ command: 'sh', args: ['-c', 'exit 1'], timeoutMs: 5000 }, { subject: 'S', body: 'B' });
  assert.equal(nonzero.ok, false);
  const missing = fireFallback({ command: 'no-such-xyzzy', args: [], timeoutMs: 5000 }, { subject: 'S', body: 'B' });
  assert.equal(missing.ok, false);
  assert.equal(missing.err, 'ENOENT');
});

// ── end-to-end through health run(): fallback fires + a kind:"alert" record is written ───
test('run: a failing check with alert.fallback fires the sink and records the attempt', async (t) => {
  const dir = tmp(t); const sink = fbSink(dir); const out = join(dir, 'health.jsonl');
  const down = join(dir, 'down.sh');
  writeFileSync(down, '#!/bin/sh\nexit 1\n'); chmodSync(down, 0o755);
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    checks: [{ type: 'command', name: 'svc', command: down }],
    alert: { app: 'myapp', fallback: { command: sink.command, when: 'always' } }, // fallback-only, no MTA
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 1 });
  assert.equal(existsSync(sink.fired), true, 'fallback fired end-to-end');
  const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const alert = recs.find((r) => r.kind === 'alert');
  assert.ok(alert, 'a kind:"alert" delivery record was written');
  assert.equal(alert.fallback.ok, true);
  assert.equal(alert.emailed, null, 'no primary configured');
});

// ── malformed fallback config fails the run loud (exit 1 territory), not silently ────────
test('run: a malformed fallback (no command) throws — surfaced loud, not swallowed', async (t) => {
  const dir = tmp(t);
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    checks: [{ type: 'command', name: 'ok', command: 'true' }],
    alert: { fallback: { args: ['x'] } }, // no command
  }));
  await assert.rejects(() => run({ configPath: cfgPath }), /non-empty string "command"/);
});
