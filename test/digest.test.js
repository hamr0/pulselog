// Digest-mode tests — metric parse, ISO-week bucketing, flightlog rollup, render,
// and the orchestrator end-to-end (dry-run / append / skipIfFlat / bad-config).
// The load-bearing one is the **privacy invariant**: only integers and error
// names+counts may reach the history line or the email — never a message or stack.
// `node --test`. Pure logic + tmp-file I/O; no network, no real mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMetric, isoWeek, loadWeeks, flightlogSummary, fmtDelta, renderDigest,
} from '../src/metrics.js';
import { runDigest } from '../src/digest.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pulselog-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Collect everything written to process.stdout while `fn` runs; restore after. */
function captureStdout(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

const ANCHOR = Date.parse('2026-05-31T08:00:00.000Z'); // a Sunday → ISO 2026-W22
const DAY = 86_400_000;

// ── runMetric: a command that prints exactly one integer, else null ─────────────
test('runMetric: integer parsed; float/text/failed/missing → null', () => {
  assert.equal(runMetric({ command: 'echo', args: ['42'] }), 42);
  assert.equal(runMetric({ command: 'echo', args: ['0'] }), 0);
  assert.equal(runMetric({ command: 'echo', args: ['3.5'] }), null, 'float is not an integer');
  assert.equal(runMetric({ command: 'echo', args: ['hello'] }), null, 'non-number → null');
  assert.equal(runMetric({ command: 'node', args: ['-e', 'process.exit(1)'] }), null, 'non-zero exit → null');
  assert.equal(runMetric({ command: 'definitely-no-such-binary-xyz', args: [] }), null, 'missing binary → null (no throw)');
});

// ── isoWeek: the "Thursday of the week" rule, incl. the year boundary ────────────
test('isoWeek: Thursday rule, including the Dec→Jan boundary', () => {
  assert.equal(isoWeek('2026-05-31T08:00:00.000Z'), '2026-W22');
  assert.equal(isoWeek('2026-01-01T00:00:00.000Z'), '2026-W01');
  // a late-December Monday belongs to next year's W01 (its Thursday is in 2026):
  assert.equal(isoWeek('2025-12-29T00:00:00.000Z'), '2026-W01');
  // and the inverse — early-January days that belong to the prior ISO year:
  assert.equal(isoWeek('2027-01-03T00:00:00.000Z'), '2026-W53');
  assert.equal(isoWeek('2027-01-04T00:00:00.000Z'), '2027-W01');
});

// ── loadWeeks: one row per ISO week (the latest), sorted, junk skipped ───────────
test('loadWeeks: latest snapshot per week, sorted oldest→newest, junk skipped', () => {
  const jsonl = [
    '{"ts":"2026-05-18T08:00:00.000Z","kind":"stats","users":90}',   // W21
    '{"ts":"2026-05-20T08:00:00.000Z","kind":"stats","users":95}',   // W21 (later → wins)
    '',                                                               // blank skipped
    'not json at all',                                               // unparseable skipped
    '{"kind":"stats","users":1}',                                    // no ts skipped
    '{"ts":"2026-05-31T08:00:00.000Z","kind":"stats","users":128}',  // W22
  ].join('\n');
  const weeks = loadWeeks(jsonl);
  assert.deepEqual(weeks.map((w) => w.week), ['2026-W21', '2026-W22']);
  assert.equal(weeks[0].users, 95, 'latest-in-week wins');
  assert.equal(weeks[1].users, 128);
});

// ── flightlogSummary: 7-day window, group + top + flag — names & counts only ─────
test('flightlogSummary: windowed counts, top names, ≥flag list', () => {
  const recent = (n) => new Date(ANCHOR - n * DAY).toISOString();
  const lines = [];
  for (let i = 0; i < 21; i++) lines.push(`{"ts":"${recent(1)}","kind":"uncaught","name":"ApiTimeout"}`);
  for (let i = 0; i < 3; i++) lines.push(`{"ts":"${recent(2)}","kind":"uncaught","name":"MailAuth"}`);
  lines.push(`{"ts":"${recent(10)}","kind":"uncaught","name":"OldError"}`); // outside 7d window
  const s = flightlogSummary(lines.join('\n'), { flagAtLeast: 20, now: ANCHOR });

  assert.equal(s.total_7d, 24, 'old error excluded from the 7-day total');
  assert.equal(s.top.ApiTimeout, 21);
  assert.equal(s.top.MailAuth, 3);
  assert.equal(s.top.OldError, undefined, 'out-of-window group absent');
  assert.deepEqual(s.flagged, ['ApiTimeout'], 'only the ≥20 group is flagged');
});

// ── fmtDelta + renderDigest ─────────────────────────────────────────────────────
test('fmtDelta: signed, blank on zero/missing/baseline', () => {
  assert.equal(fmtDelta(10, 7), '+3');
  assert.equal(fmtDelta(7, 10), '-3');
  assert.equal(fmtDelta(5, 5), '', 'flat → blank');
  assert.equal(fmtDelta(5, null), '', 'no prior week → blank');
  assert.equal(fmtDelta(null, 5), '', 'missing current → blank');
});

test('renderDigest: WoW table over declared columns + one flightlog line (pure)', () => {
  const weeks = [
    { week: '2026-W21', users: 100, pins: 3000 },
    { week: '2026-W22', users: 128, pins: 3000 },
  ];
  const body = renderDigest({
    app: 'myapp', weeks, metricNames: ['users', 'pins'],
    flightlog: { total_7d: 24, top: { ApiTimeout: 21 }, flagged: ['ApiTimeout'] },
  });
  assert.match(body, /myapp weekly stats — 2026-W21 → 2026-W22/);
  assert.match(body, /users/);
  assert.match(body, /\+28/, 'users WoW delta shown');
  assert.doesNotMatch(body, /\+0|\bpins\b.*\+/, 'flat pins column has no delta');
  assert.match(body, /flightlog \(last 7d\): 24 errors/);
  assert.match(body, /ApiTimeout×21/);
});

// ── runDigest orchestrator ──────────────────────────────────────────────────────
function writeCfg(dir, digest) {
  const p = join(dir, 'cfg.json');
  writeFileSync(p, JSON.stringify({ digest }));
  return p;
}

test('runDigest --dry-run: renders to stdout, writes nothing', (t) => {
  const dir = tmp(t);
  const history = join(dir, 'stats.jsonl');
  const cfg = writeCfg(dir, {
    app: 'demo', history,
    metrics: [{ name: 'users', command: 'echo', args: ['7'] }],
  });
  let res;
  const out = captureStdout(() => { res = runDigest({ configPath: cfg, dryRun: true, now: ANCHOR }); });
  assert.equal(res.delivered, 'dry-run');
  assert.equal(res.metrics.users, 7);
  assert.equal(existsSync(history), false, 'dry-run appends nothing');
  assert.match(out, /Subject: \[demo\] weekly stats — 2026-W22/);
});

test('runDigest real run: appends one stats line; delivered "none" with no email', (t) => {
  const dir = tmp(t);
  const history = join(dir, 'stats.jsonl');
  const cfg = writeCfg(dir, {
    app: 'demo', history,
    metrics: [
      { name: 'users', command: 'echo', args: ['42'] },
      { name: 'broken', command: 'echo', args: ['notanint'] },
    ],
  });
  const res = runDigest({ configPath: cfg, now: ANCHOR });
  assert.equal(res.delivered, 'none');
  const recs = readFileSync(history, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'stats');     // flightlog-compatible core shape
  assert.equal(recs[0].app, 'demo');
  assert.equal(recs[0].users, 42);
  assert.equal(recs[0].broken, null, 'a broken metric records null, never sinks the run');
});

test('runDigest skipIfFlat: identical prior week + no flag → "skipped"', (t) => {
  const dir = tmp(t);
  const history = join(dir, 'stats.jsonl');
  // seed a prior week (W21) with the same value the metric will return this week
  writeFileSync(history, '{"ts":"2026-05-24T08:00:00.000Z","kind":"stats","app":"demo","users":100}\n');
  const cfg = writeCfg(dir, {
    app: 'demo', history, skipIfFlat: true,
    metrics: [{ name: 'users', command: 'echo', args: ['100'] }],
  });
  const res = runDigest({ configPath: cfg, now: ANCHOR });
  assert.equal(res.delivered, 'skipped');
});

test('runDigest: a config without digest.metrics throws (loud misconfig)', (t) => {
  const dir = tmp(t);
  const cfg = join(dir, 'bad.json');
  writeFileSync(cfg, JSON.stringify({ digest: {} }));
  assert.throws(() => runDigest({ configPath: cfg, now: ANCHOR }), /digest\.metrics/);
});

// ── THE PRIVACY INVARIANT ───────────────────────────────────────────────────────
// flightlog enrichment must surface error *names and counts* only. A secret in an
// error's message/stack must never reach the persisted history line nor the email.
test('privacy invariant: error message/stack never reach the history line or the email', (t) => {
  const dir = tmp(t);
  const SECRET_MSG = 'SECRET token=abc123 leaked to logs';
  const SECRET_STACK = 'at /home/user/secret/handler.js:42:7';
  const recent = new Date(ANCHOR - DAY).toISOString();

  // 25 ApiError lines (over the flag) — each carrying the secret message + stack
  const errLines = [];
  for (let i = 0; i < 25; i++) {
    errLines.push(JSON.stringify({
      ts: recent, kind: 'uncaught', name: 'ApiError',
      message: SECRET_MSG, stack: SECRET_STACK,
    }));
  }
  const errFile = join(dir, 'errors.jsonl');
  writeFileSync(errFile, errLines.join('\n') + '\n');

  const history = join(dir, 'stats.jsonl');
  const cfg = writeCfg(dir, {
    app: 'demo', history,
    metrics: [{ name: 'users', command: 'echo', args: ['10'] }],
    flightlog: { file: errFile, groupBy: 'name', flagAtLeast: 20 },
  });

  // 1) the email body (captured from the real --dry-run render path)
  let res;
  const body = captureStdout(() => { res = runDigest({ configPath: cfg, dryRun: true, now: ANCHOR }); });
  assert.match(body, /ApiError/, 'the error NAME is surfaced');
  assert.match(body, /25/, 'the COUNT is surfaced');
  assert.doesNotMatch(body, /SECRET|token=abc123/, 'no message content in the email');
  assert.doesNotMatch(body, /secret\/handler\.js/, 'no stack content in the email');

  // 2) the persisted history line (the record) — real run this time
  runDigest({ configPath: cfg, now: ANCHOR });
  const lineRaw = readFileSync(history, 'utf8').trim();
  const line = JSON.parse(lineRaw);
  assert.equal(line.errors.top.ApiError, 25, 'names+counts persisted');
  assert.deepEqual(line.errors.flagged, ['ApiError']);
  assert.doesNotMatch(lineRaw, /SECRET|token=abc123|secret\/handler\.js/,
    'no message or stack anywhere in the persisted snapshot');
  // belt-and-suspenders: the flagged value is a bare name, not an object carrying detail
  assert.equal(res.flagged.join(','), 'ApiError');
});
