// Tests for the shared subprocess-delivery primitive. Behavior only: real child
// processes, evidence read back off disk — no mocks. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDelivery } from '../src/deliver.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deliver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A sink that copies stdin → $OUT_BODY and $PULSELOG_SUBJECT → $OUT_SUBJ. */
function recorder(dir) {
  const p = join(dir, 'sink.sh');
  writeFileSync(p, '#!/bin/sh\ncat > "$OUT_BODY"\nprintf %s "$PULSELOG_SUBJECT" > "$OUT_SUBJ"\n');
  chmodSync(p, 0o755);
  return p;
}

test('spawnDelivery: clean exit 0 → ok', () => {
  const r = spawnDelivery('sh', ['-c', 'exit 0']);
  assert.deepEqual({ ok: r.ok, code: r.code, killed: r.killed, err: r.err }, { ok: true, code: 0, killed: false, err: null });
});

test('spawnDelivery: non-zero exit → not ok, code preserved', () => {
  const r = spawnDelivery('sh', ['-c', 'exit 3']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.killed, false);
});

test('spawnDelivery: missing binary → not ok, ENOENT surfaced (no throw)', () => {
  const r = spawnDelivery('no-such-binary-xyzzy');
  assert.equal(r.ok, false);
  assert.equal(r.err, 'ENOENT');
});

test('spawnDelivery: timeout kills the child and flags it (fast)', () => {
  const start = Date.now();
  const r = spawnDelivery('sh', ['-c', 'sleep 10'], { timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(r.killed, true);
  assert.ok(elapsed < 8000, `honored the 300ms timeout, took ${elapsed}ms`);
});

// spawnSync's default timeout signal is SIGTERM; a child that ignores it would keep the run
// blocked until it exits on its own. The kill must be SIGKILL so the timeout is a real bound.
test('spawnDelivery: a TERM-ignoring child is still cut off at the timeout', () => {
  const start = Date.now();
  const r = spawnDelivery('sh', ['-c', 'trap "" TERM; sleep 10'], { timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.equal(r.killed, true);
  assert.equal(r.reason, 'timeout');
  assert.ok(elapsed < 5000, `must not wait out the child's 10s sleep, took ${elapsed}ms`);
});

test('spawnDelivery: input reaches the child stdin byte-exact; env merges', (t) => {
  const dir = tmp(t);
  const sink = recorder(dir);
  const outBody = join(dir, 'b');
  const outSubj = join(dir, 's');
  const BODY = 'line one\n\n  ✗ db [tcp]: timeout after 5s\nWhen: 2026-07-02\n';
  const r = spawnDelivery(sink, [], {
    input: BODY,
    env: { PULSELOG_SUBJECT: '[app] alert', OUT_BODY: outBody, OUT_SUBJ: outSubj },
  });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(outBody, 'utf8'), BODY, 'stdin body arrives byte-exact');
  assert.equal(readFileSync(outSubj, 'utf8'), '[app] alert', 'env var reaches the child');
});

/** Synchronous sleep (the code under test is synchronous; keep the test so too). */
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 0.8.0: the real incident — `mail` → `postdrop` grandchild looping on a permission
// error. A timeout that kills only the direct child leaves the grandchild running.
test('spawnDelivery: timeout kills the whole process group, not just the child', (t) => {
  const dir = tmp(t);
  const pidFile = join(dir, 'gc.pid');
  const r = spawnDelivery('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { timeoutMs: 2000 });
  assert.equal(r.killed, true);
  assert.equal(r.reason, 'timeout');
  const gc = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(gc, 'SIGKILL'); } catch { /* already gone */ } });
  for (let i = 0; i < 20 && alive(gc); i++) nap(50);
  assert.equal(alive(gc), false, `grandchild ${gc} must not survive the timeout`);
});

test('spawnDelivery: reason names the failure — exit N / errno / null on success', () => {
  assert.equal(spawnDelivery('sh', ['-c', 'exit 0']).reason, null);
  assert.equal(spawnDelivery('sh', ['-c', 'exit 75']).reason, 'exit 75');
  assert.equal(spawnDelivery('no-such-binary-xyzzy').reason, 'ENOENT');
});

// A child that exits without draining stdin makes spawnSync report EPIPE even though it ran
// and exited. ~200KB overflows the pipe buffer, so the EPIPE is deterministic, not a race.
const BIG = 'x'.repeat(200_000);

test('spawnDelivery: exit 0 without reading a large stdin → ok, not EPIPE', () => {
  const r = spawnDelivery('sh', ['-c', 'exit 0'], { input: BIG });
  assert.deepEqual({ ok: r.ok, code: r.code, err: r.err, reason: r.reason }, { ok: true, code: 0, err: null, reason: null });
});

test('spawnDelivery: exit 3 without reading a large stdin → reason "exit 3", not EPIPE', () => {
  const r = spawnDelivery('sh', ['-c', 'exit 3'], { input: BIG });
  assert.deepEqual({ ok: r.ok, code: r.code, err: r.err, reason: r.reason }, { ok: false, code: 3, err: null, reason: 'exit 3' });
});
