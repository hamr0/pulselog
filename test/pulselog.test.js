// Tests — pure logic + a couple of real-I/O integration checks (a local HTTP
// server, tmp files). No network to the outside world. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, fileAge, disk, service, command } from '../src/checks.js';
import { assembleEmail, sendEmail } from '../src/email.js';
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

/** Prepend `dir` to PATH for the duration of the test (to shadow a real binary). */
function shadowPath(t, dir) {
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  t.after(() => { process.env.PATH = orig; });
}

/**
 * Write an executable script that exits 0 only once its own call-counter reaches
 * `succeedOn` — a deterministic flaky check for exercising in-run retry.
 */
function flakyScript(dir, name, succeedOn) {
  const counter = join(dir, `${name}.count`);
  const path = join(dir, name);
  writeFileSync(path,
    `#!/bin/sh\nf="${counter}"\nn=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$f"\n[ "$n" -ge ${succeedOn} ]\n`);
  chmodSync(path, 0o755);
  return path;
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

// Date-stamped backup layout (addypin: daily/<date>/app.db). The fresh file lives
// one level down, so the default single-level scan must NOT see it, and recursive
// MUST — same tree, the flag is the only difference.
test('file-age: recursive finds files in date-stamped subdirs; default does not', async (t) => {
  const root = tmp(t);
  const day = join(root, 'daily', '2026-05-31');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'addypin.db'), 'x');

  const shallow = await fileAge({ path: join(root, 'daily'), maxAgeHours: 26, pattern: '.db' });
  assert.equal(shallow.ok, false, 'single-level scan must not descend');
  assert.match(shallow.reason, /no files/);

  const deep = await fileAge({ path: join(root, 'daily'), maxAgeHours: 26, pattern: '.db', recursive: true });
  assert.equal(deep.ok, true, 'recursive scan must find the nested backup');
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

test('sendEmail[sec]: a newline in a header field cannot inject a mail header', (t) => {
  const dir = tmp(t);
  const rec = join(dir, 'rec');
  // fake `mail` on PATH that records its argv verbatim
  writeFileSync(join(dir, 'mail'), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done > ${rec}\n`);
  chmodSync(join(dir, 'mail'), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig}`;
  t.after(() => { process.env.PATH = orig; });

  const via = sendEmail({ to: 'ops@x', from: 'a@b', subject: 'hi\nBcc: attacker@evil.test', body: 'B' });
  assert.equal(via.transport, 'mail');
  assert.equal(via.ok, true, 'fake mail exits 0 → handoff reported ok');
  const got = readFileSync(rec, 'utf8');
  assert.doesNotMatch(got, /\n/, 'no newline reaches the header fields');
  assert.match(got, /Bcc: attacker@evil\.test/, 'the injection attempt is flattened into the subject text, not a header');
});

// The handoff-outcome signal the fallback sink (0.7.0) reads. A non-zero `mail` exit
// must surface as ok:false — not the old "returned 'mail' regardless of exit" behavior.
test('sendEmail: reports ok:false when the MTA handoff exits non-zero', (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'mail'), '#!/bin/sh\nexit 3\n'); // handoff fails
  chmodSync(join(dir, 'mail'), 0o755);
  shadowPath(t, dir);
  const via = sendEmail({ to: 'ops@x', from: 'a@b', subject: 's', body: 'B' });
  assert.equal(via.transport, 'mail', 'transport still identified');
  assert.equal(via.ok, false, 'a non-zero mail handoff is reported failed, not swallowed');
});

// ── (M1) CLI refuses a config others can write — it executes commands as us ──────
test('CLI[sec]: refuses a group/world-writable config; runs a 0600 one', (t) => {
  const dir = tmp(t);
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ checks: [] }));
  const BIN = fileURLToPath(new URL('../bin/pulselog.js', import.meta.url));

  chmodSync(cfg, 0o666);
  const bad = spawnSync(process.execPath, [BIN, '--config', cfg], { encoding: 'utf8' });
  assert.equal(bad.status, 1, 'a world-writable config is refused');
  assert.match(bad.stderr, /group\/world-writable/);

  chmodSync(cfg, 0o600);
  const ok = spawnSync(process.execPath, [BIN, '--config', cfg], { encoding: 'utf8' });
  assert.equal(ok.status, 0, 'a 0600 config runs');
});

// ── (a) per-check timeoutMs on service/disk + a labeled timeout ──────────────────
// service and disk used to hardcode 5000ms and never label a kill as a timeout. Both
// now read `timeoutMs` and say "timeout after Ns". A fake binary that sleeps far past
// the timeout proves the knob is honored (fast return) AND the label is correct.
test('disk: honors timeoutMs and labels a timeout', async (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'df'), '#!/bin/sh\nsleep 10\n');
  chmodSync(join(dir, 'df'), 0o755);
  shadowPath(t, dir);
  const start = Date.now();
  const r = await disk({ path: '/', timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout/);
  assert.ok(elapsed < 3000, `should honor the 300ms timeout, took ${elapsed}ms`);
});

test('service: honors timeoutMs and labels a timeout', async (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\nsleep 10\n');
  chmodSync(join(dir, 'systemctl'), 0o755);
  shadowPath(t, dir);
  const start = Date.now();
  const r = await service({ unit: 'whatever.service', timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout/);
  assert.ok(elapsed < 3000, `should honor the 300ms timeout, took ${elapsed}ms`);
});

// ── (a2) command timeout reads `timeout after Ns`, not the misleading `exit 1` ────
// A kill by timeout gives execFile err.code === null → synthesised 1, so the old
// `exit 1 (timeout)` read like a genuine exit-1 failure. Now it aligns with the other
// checks. A genuine non-zero exit must still read `exit N` — the two paths stay distinct.
test('command: a timeout kill reads "timeout after Ns", not "exit 1"', async (t) => {
  const start = Date.now();
  const r = await command({ command: 'sh', args: ['-c', 'sleep 10'], timeoutMs: 1000 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.match(r.reason, /^timeout after \d+s/);
  assert.doesNotMatch(r.reason, /exit 1/, 'must not synthesise an exit code for a kill');
  assert.ok(elapsed < 4000, `should honor the 1s timeout, took ${elapsed}ms`);
});

test('command: a genuine non-zero exit still reads "exit N"', async (t) => {
  const r = await command({ command: 'sh', args: ['-c', 'echo boom >&2; exit 3'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^exit 3/);
  assert.match(r.reason, /boom/, 'stderr tail preserved');
  assert.doesNotMatch(r.reason, /timeout/, 'a real exit is not a timeout');
});

// ── (b) in-run retry: a transient failure is re-probed before it pages ───────────
test('run: retries a flaky check and records green when it recovers', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'health.jsonl');
  const script = flakyScript(dir, 'flaky', 2); // fails attempt 1, passes attempt 2
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    checks: [{ type: 'command', name: 'flaky', command: script, retries: 2, retryDelayMs: 0 }],
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 0 }, 'recovered on retry → no failure');
  assert.equal(existsSync(out), false, 'silent on green');
});

test('run: a check failing every attempt is recorded ONCE, noting the attempts', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'health.jsonl');
  const script = flakyScript(dir, 'down', 99); // never succeeds within the attempts
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    checks: [{ type: 'command', name: 'down', command: script, retries: 1, retryDelayMs: 0 }],
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 1 });
  const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 1, 'one failure line despite retries — not one per attempt');
  assert.match(recs[0].message, /after 2 attempts/);
});

test('run: default is no retry (one attempt, no annotation)', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'health.jsonl');
  const script = flakyScript(dir, 'once', 2); // WOULD pass on attempt 2, but no retry
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    checks: [{ type: 'command', name: 'once', command: script }],
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 1 }, 'no retry by default → fails on first attempt');
  const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.doesNotMatch(recs[0].message, /attempts/, 'no retry annotation when retries=0');
});

test('run: a non-integer/negative retries is coerced (no loop-bound warp or crash)', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'health.jsonl');
  const script = flakyScript(dir, 'str', 99); // never recovers within a sane attempt count
  const cfgPath = join(dir, 'cfg.json');
  // retries as a STRING would make `retries + 1` evaluate to "21" (21 attempts) if used
  // raw; coercion clamps it to the integer 2 → exactly 3 attempts.
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    checks: [{ type: 'command', name: 'str', command: script, retries: '2', retryDelayMs: 0 }],
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 1 });
  assert.match(JSON.parse(readFileSync(out, 'utf8').trim()).message, /after 3 attempts/,
    'string "2" → 2 retries → 3 attempts, not 21');

  // a negative value must not crash the run (clamps to 0 → one attempt, no annotation)
  const out2 = join(dir, 'h2.jsonl');
  const cfg2 = join(dir, 'c2.json');
  writeFileSync(cfg2, JSON.stringify({
    output: { file: out2, maxBytes: 0 },
    checks: [{ type: 'command', name: 'neg', command: flakyScript(dir, 'neg', 99), retries: -5 }],
  }));
  const res2 = await run({ configPath: cfg2 });
  assert.deepEqual(res2, { total: 1, failures: 1 }, 'negative retries does not crash the run');
  assert.doesNotMatch(JSON.parse(readFileSync(out2, 'utf8').trim()).message, /attempts/);
});

test('run: config.retry default applies when a check omits its own', async (t) => {
  const dir = tmp(t);
  const out = join(dir, 'health.jsonl');
  const script = flakyScript(dir, 'g', 2);
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    output: { file: out, maxBytes: 0 },
    retry: { retries: 2, retryDelayMs: 0 },
    checks: [{ type: 'command', name: 'g', command: script }],
  }));
  const res = await run({ configPath: cfgPath });
  assert.deepEqual(res, { total: 1, failures: 0 }, 'global retry default recovers the flaky check');
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
