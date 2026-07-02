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
  assert.ok(elapsed < 3000, `honored the 300ms timeout, took ${elapsed}ms`);
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
