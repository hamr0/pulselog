// Tests — pure logic + a couple of real-I/O integration checks (a local HTTP
// server, tmp files). No network to the outside world. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, fileAge, disk } from '../src/checks.js';
import { assembleEmail } from '../src/email.js';
import { run } from '../src/run.js';

/** Spin a one-response HTTP server on an ephemeral port; returns { url, close }. */
function server(status, body = 'ok') {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => srv.close() });
    });
  });
}

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pulselog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('http: 200 is ok, non-expected status fails', async () => {
  const okSrv = await server(200);
  try {
    assert.equal((await http({ url: okSrv.url })).ok, true);
  } finally {
    okSrv.close();
  }
  const badSrv = await server(503);
  try {
    const r = await http({ url: badSrv.url, expectStatus: 200 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 503/);
  } finally {
    badSrv.close();
  }
});

test('http: an unreachable url fails (not throws)', async () => {
  const r = await http({ url: 'http://127.0.0.1:1/', timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreachable/);
});

test('file-age: fresh dir ok, stale file fails', async (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'backup.sqlite'), 'x');
  assert.equal((await fileAge({ path: dir, maxAgeHours: 24, pattern: '.sqlite' })).ok, true);

  const old = join(dir, 'old.sqlite');
  writeFileSync(old, 'x');
  const longAgo = Date.now() / 1000 - 48 * 3600; // 48h ago, in seconds
  utimesSync(old, longAgo, longAgo);
  const r = await fileAge({ path: old, maxAgeHours: 24 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale/);
});

test('file-age: empty/missing target fails cleanly', async (t) => {
  const dir = tmp(t);
  const r = await fileAge({ path: dir, maxAgeHours: 24, pattern: '.sqlite' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no files/);
});

test('disk: root is below 100% and parses a percent', async () => {
  const r = await disk({ path: '/', maxPercent: 100 });
  assert.equal(r.ok, true);
  assert.equal(typeof r.detail.percent, 'number');
});

test('assembleEmail: subject + body name the failing checks', () => {
  const { subject, body } = assembleEmail({
    failures: [
      { cfg: { name: 'api', type: 'http' }, reason: 'HTTP 503' },
      { cfg: { name: 'cert', type: 'ssl' }, reason: 'cert expires in 3d' },
    ],
    host: 'box1',
    ts: '2026-05-31T12:00:00.000Z',
    alert: { app: 'myapp' },
  });
  assert.match(subject, /\[myapp\].*2 check/);
  assert.match(body, /api \[http\]: HTTP 503/);
  assert.match(body, /cert \[ssl\]: cert expires in 3d/);
});

test('run: silent on green (no file written), records each failure on red', async (t) => {
  const dir = tmp(t);
  const cfgPath = join(dir, 'cfg.json');
  const out = join(dir, 'health.jsonl');

  // green: one passing http check, no alert email → nothing written
  const okSrv = await server(200);
  try {
    writeFileSync(cfgPath, JSON.stringify({
      output: { file: out, maxBytes: 0 },
      checks: [{ type: 'http', name: 'api', url: okSrv.url }],
    }));
    const res = await run({ configPath: cfgPath });
    assert.deepEqual(res, { total: 1, failures: 0 });
    assert.equal(existsSync(out), false, 'silent on green — no JSONL file');
  } finally {
    okSrv.close();
  }

  // red: a 500 + a disabled check (must be skipped) → one failure line
  const badSrv = await server(500);
  try {
    writeFileSync(cfgPath, JSON.stringify({
      output: { file: out, maxBytes: 0 },
      checks: [
        { type: 'http', name: 'api', url: badSrv.url, expectStatus: 200 },
        { type: 'http', name: 'disabled', enabled: false, url: badSrv.url },
      ],
    }));
    const res = await run({ configPath: cfgPath });
    assert.deepEqual(res, { total: 1, failures: 1 }, 'disabled check is skipped');
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'health');       // flightlog-compatible core shape
    assert.equal(recs[0].name, 'api');
    assert.equal(recs[0].status, 'fail');
    assert.equal(recs[0].check_type, 'http');
  } finally {
    badSrv.close();
  }
});
