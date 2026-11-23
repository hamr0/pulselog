// Tests for examples/dmarc.mjs, run as a child process. SYNTHETIC fixtures only: the XML and
// the zip/gzip/multipart/Maildir wrapping are all built here, never copied from a real report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { run as healthRun } from '../src/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';

const SCRIPT = fileURLToPath(new URL('../examples/dmarc.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args.map(String)], { encoding: 'utf8' });
// ONE temp root for the whole file, removed afterwards; every fixture lives under it.
const ROOT = mkdtempSync(join(tmpdir(), 'dmarc-example-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let seq = 0;
const tmp = () => { const d = join(ROOT, String(seq++)); mkdirSync(d); return d; };
const lines = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- fixtures ----
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
function xml({ org = 'google.com', id = 'r1', domain = 'example.com', p = 'none', end = NOW - DAY, rows } = {}) {
  rows ??= [{ ip: '203.0.113.7', count: 3, dkim: 'pass', spf: 'pass' }];
  const recs = rows.map((r) => `<record><row><source_ip>${r.ip}</source_ip><count>${r.count}</count>
    <policy_evaluated><disposition>${r.disposition || 'none'}</disposition><dkim>${r.dkim}</dkim><spf>${r.spf}</spf></policy_evaluated></row>
    <auth_results><dkim><result>fail</result></dkim></auth_results></record>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata><org_name>${org}</org_name><report_id>${id}</report_id>
    <date_range><begin>${end - DAY + 1}</begin><end>${end}</end></date_range></report_metadata>
  <policy_published><domain>${domain}</domain><p>${p}</p><pct>100</pct></policy_published>
  ${recs}
</feedback>`;
}

// Minimal one-entry zip (CRC left 0: the script doesn't check it): local header + data + central directory + EOCD.
function zip(content, { method = 8, descriptor = false } = {}) {
  const raw = Buffer.from(content);
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const name = Buffer.from('report.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(descriptor ? 0 : data.length, 18); local.writeUInt32LE(descriptor ? 0 : raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const dd = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(0, 4);
    dd.writeUInt32LE(data.length, 8); dd.writeUInt32LE(raw.length, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length + dd.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, dd, central, name, eocd]);
}

const b64 = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
// Folded Content-Type, as real mail has it.
const zipMail = (buf) => `From: dmarc@google.com\r\nMIME-Version: 1.0\r\nContent-Type: application/zip;\r\n\tname="r.zip"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(buf)}\r\n`;
const multipart = (partHeaders, body) => `From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed;\r\n\tboundary="BND"\r\n\r\n--BND\r\nContent-Type: text/plain\r\n\r\nhello\r\n--BND\r\n${partHeaders}\r\n\r\n${body}\r\n--BND--\r\n`;

// A plain folder or Maildir ({ maildir: true }) holding the given { name: content } messages.
function inbox(files, { maildir = false, sub = 'new' } = {}) {
  const dir = tmp();
  const target = maildir ? join(dir, sub) : dir;
  if (maildir) for (const d of ['new', 'cur', 'tmp']) mkdirSync(join(dir, d));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(target, n), c);
  return { dir, out: join(ROOT, `${seq++}.jsonl`) };
}
const names = (dir, sub) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []);

// ---- ingest ----
test('ingest: single-part base64 zip with folded Content-Type, exact JSONL fields', () => {
  const x = xml({ id: 'abc', end: 1795391999, rows: [
    { ip: '203.0.113.7', count: 5, dkim: 'pass', spf: 'fail' },
    { ip: '198.51.100.9', count: 2, dkim: 'fail', spf: 'fail', disposition: 'quarantine' },
    { ip: '203.0.113.8', count: 1, dkim: 'fail', spf: 'pass' },
  ] });
  const { dir, out } = inbox({ 'm1.eml': zipMail(zip(x)) });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
  const [l] = lines(out);
  const { ts, ...rest } = l;
  assert.ok(Date.parse(ts) > Date.now() - 60000);
  assert.deepEqual(rest, {
    kind: 'dmarc', domain: 'example.com', org: 'google.com', report_id: 'abc',
    begin: '2026-11-22T00:00:00.000Z', end: '2026-11-22T23:59:59.000Z', p: 'none',
    msgs: 8, dkim_aligned: 5, spf_aligned: 1, fail: 2,
    sources: [
      { ip: '203.0.113.7', count: 5, dkim: 'pass', spf: 'fail', disposition: 'none' },
      { ip: '198.51.100.9', count: 2, dkim: 'fail', spf: 'fail', disposition: 'quarantine' },
      { ip: '203.0.113.8', count: 1, dkim: 'fail', spf: 'pass', disposition: 'none' },
    ],
  });
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(names(dir, 'done'), ['m1.eml']);
});

test('ingest: fail counts only messages where BOTH dkim and spf fail', () => {
  const x = xml({ rows: [
    { ip: '1.1.1.1', count: 1, dkim: 'pass', spf: 'fail' },
    { ip: '1.1.1.2', count: 1, dkim: 'fail', spf: 'pass' },
    { ip: '1.1.1.3', count: 1, dkim: 'pass', spf: 'pass' },
    { ip: '1.1.1.4', count: 4, dkim: 'fail', spf: 'fail' },
  ] });
  const { dir, out } = inbox({ m: zipMail(zip(x)) });
  run('ingest', dir, out);
  assert.equal(lines(out)[0].fail, 4);
});

test('ingest: stored (method 0) zip and data-descriptor zip', () => {
  const { dir, out } = inbox({
    a: zipMail(zip(xml({ id: 'stored' }), { method: 0 })),
    b: zipMail(zip(xml({ id: 'dd' }), { descriptor: true })),
  });
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 2 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(lines(out).map((l) => l.report_id).sort(), ['dd', 'stored']);
});

test('ingest: multipart with a base64 .xml.gz part, a plain xml part, and octet-stream by filename', () => {
  const { dir, out } = inbox({
    gz: multipart('Content-Type: application/gzip; name="r.xml.gz"\r\nContent-Transfer-Encoding: base64', b64(gzipSync(xml({ id: 'gz' })))),
    xml: multipart('Content-Type: text/xml\r\nContent-Transfer-Encoding: 7bit', xml({ id: 'plainxml' })),
    oct: multipart('Content-Type: application/octet-stream;\r\n name="r.xml.gz"\r\nContent-Transfer-Encoding: base64', b64(gzipSync(xml({ id: 'oct' })))),
    top: `Content-Type: application/xml\r\n\r\n${xml({ id: 'topxml' })}`,
  });
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 4 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(lines(out).map((l) => l.report_id).sort(), ['gz', 'oct', 'plainxml', 'topxml']);
});

test('ingest: x-zip-compressed / x-zip labels, and text/plain with a .xml.gz filename after a plain text part', () => {
  const { dir, out } = inbox({
    xzc: multipart('Content-Type: application/x-zip-compressed; name="r.zip"\r\nContent-Transfer-Encoding: base64', b64(zip(xml({ id: 'xzc' })))),
    xz: `Content-Type: application/x-zip\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(zip(xml({ id: 'xz' })))}\r\n`,
    tp: multipart('Content-Type: text/plain\r\nContent-Disposition: attachment; filename=report.xml.gz\r\nContent-Transfer-Encoding: base64', b64(gzipSync(xml({ id: 'tp' })))),
  });
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 3 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(lines(out).map((l) => l.report_id).sort(), ['tp', 'xz', 'xzc']);
});

test('ingest: entities are decoded', () => {
  const { dir, out } = inbox({ m: `Content-Type: text/xml\r\n\r\n${xml({ org: 'a&amp;b &lt;c&gt;' })}` });
  run('ingest', dir, out);
  assert.equal(lines(out)[0].org, 'a&b <c>');
});

test('ingest: Maildir new/ + cur/ with :2,S names; tmp/ ignored; moves go beside new/cur/tmp', () => {
  const { dir, out } = inbox({ 'one.host:2,S': zipMail(zip(xml({ id: 'n' }))) }, { maildir: true, sub: 'new' });
  writeFileSync(join(dir, 'cur', 'two.host:2,RS'), zipMail(zip(xml({ id: 'c' }))));
  writeFileSync(join(dir, 'tmp', 'partial'), zipMail(zip(xml({ id: 't' }))));
  const r = run('ingest', dir, out);
  assert.equal(r.stdout, 'dmarc ingest: 2 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(lines(out).map((l) => l.report_id).sort(), ['c', 'n']);
  assert.deepEqual(names(dir, 'done'), ['one.host:2,S', 'two.host:2,RS']);
  assert.deepEqual(names(dir, 'tmp'), ['partial']);
  assert.deepEqual([names(dir, 'new'), names(dir, 'cur')], [[], []]);
  assert.deepEqual(names(dir, 'new/done'), []);
});

test('ingest: duplicate (org, report_id) is skipped within a run and across runs, but still moved to done/', () => {
  const m = zipMail(zip(xml({ id: 'same' })));
  const { dir, out } = inbox({ a: m, b: m });
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 1 new, 1 duplicate, 0 bad\n');
  writeFileSync(join(dir, 'c'), m);
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 0 new, 1 duplicate, 0 bad\n');
  assert.equal(lines(out).length, 1);
  assert.equal(names(dir, 'done').length, 3);
  // same report_id from a DIFFERENT org is a different report
  writeFileSync(join(dir, 'd'), zipMail(zip(xml({ id: 'same', org: 'yahoo.com' }))));
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
});

test('ingest: malformed mail goes to bad/ with a dmarc-error line; good mail in the same run still lands; exit 0', () => {
  const good = zipMail(zip(xml({ id: 'ok' })));
  const { dir, out } = inbox({
    good,
    badb64: 'Content-Type: application/zip\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!not base64!!!\r\n',
    unknown: 'Content-Type: text/plain\r\n\r\nhello there\r\n',
    notdmarc: `Content-Type: text/xml\r\n\r\n<html><p>hi</p></html>`,
    truncated: zipMail(zip(xml({ id: 'tr' })).subarray(0, 60)),
    nodata: 'Subject: nothing\r\n\r\n',
  });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'dmarc ingest: 1 new, 0 duplicate, 5 bad\n');
  assert.deepEqual(names(dir, 'bad'), ['badb64', 'nodata', 'notdmarc', 'truncated', 'unknown']);
  assert.deepEqual(names(dir, 'done'), ['good']);
  const errs = lines(out).filter((l) => l.kind === 'dmarc-error');
  assert.deepEqual(errs.map((e) => e.file).sort(), ['badb64', 'nodata', 'notdmarc', 'truncated', 'unknown']);
  const reason = Object.fromEntries(errs.map((e) => [e.file, e.reason]));
  assert.match(reason.badb64, /base64/);
  assert.match(reason.unknown, /content type/);
  assert.match(reason.notdmarc, /not a DMARC/);
  assert.match(reason.truncated, /truncated|zip/);
  assert.equal(lines(out).filter((l) => l.kind === 'dmarc').length, 1);
});

test('ingest: done/ and bad/ are never re-read, and only top-level files of a plain dir are used', () => {
  const { dir, out } = inbox({ 'top.eml': zipMail(zip(xml({ id: 'top' }))) });
  for (const d of ['done', 'bad', 'sub']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'x'), zipMail(zip(xml({ id: d })))); }
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(lines(out).map((l) => l.report_id), ['top']);
  assert.deepEqual(names(dir, 'bad'), ['x']);
});

test('ingest: usage errors and unreadable paths exit 1', () => {
  const { dir, out } = inbox({});
  assert.equal(run('ingest', dir).status, 1);
  assert.equal(run('ingest', join(dir, 'nope'), out).status, 1);
  assert.equal(run('ingest', dir, join(dir, 'no', 'such', 'dir', 'o.jsonl')).status, 1);
  assert.equal(run('bogus').status, 1);
  assert.match(run().stderr, /usage/);
});

// ---- metric / check ----
// Hand-write a JSONL so metric/check are tested independently of ingest.
function history(reports) {
  const dir = tmp();
  const p = join(dir, 'd.jsonl');
  const rec = (domain, endAgo, sources, extra = {}) => ({
    ts: 'x', kind: 'dmarc', domain, org: 'o', report_id: `${Math.random()}`,
    end: new Date((NOW - endAgo * DAY) * 1000).toISOString(),
    msgs: sources.reduce((n, s) => n + s.count, 0),
    fail: sources.filter((s) => s.dkim !== 'pass' && s.spf !== 'pass').reduce((n, s) => n + s.count, 0),
    sources, ...extra,
  });
  writeFileSync(p, reports.map((r) => JSON.stringify(rec(...r))).join('\n') + '\n' + '{"kind":"dmarc-error","file":"f","reason":"r"}\nnot json\n');
  return p;
}
const S = (ip, count, dkim = 'pass', spf = 'pass') => ({ ip, count, dkim, spf, disposition: 'none' });

test('metric: msgs / pass-pct / unknown-ips over the window; old reports, other domains, error lines ignored', () => {
  const p = history([
    ['a.com', 1, [S('203.0.113.7', 8), S('198.51.100.1', 2, 'fail', 'fail')]],
    ['a.com', 3, [S('203.0.113.7', 10), S('198.51.100.2', 5, 'fail', 'pass')]],
    ['a.com', 30, [S('192.0.2.1', 99, 'fail', 'fail')]], // outside 7 days
    ['b.com', 1, [S('192.0.2.50', 7)]],
  ]);
  assert.equal(run('metric', p, 'a.com', 'msgs').stdout, '25\n');
  assert.equal(run('metric', p, 'a.com', 'pass-pct').stdout, '92\n'); // 23/25
  assert.equal(run('metric', p, 'a.com', 'unknown-ips', '--expected', '203.0.113.7').stdout, '2\n');
  assert.equal(run('metric', p, 'a.com', 'unknown-ips', '--expected', '203.0.113.0/24,198.51.100.0/24').stdout, '0\n');
  assert.equal(run('metric', p, 'a.com', 'msgs', '--days', '60').stdout, '124\n');
  assert.equal(run('metric', p, 'a.com', 'msgs', '--days', '2').stdout, '10\n');
});

test('metric: no mail -> msgs 0, pass-pct 100, unknown-ips 0; missing file reads the same; bad args exit 1', () => {
  const p = history([['a.com', 1, [S('203.0.113.7', 1)]]]);
  assert.equal(run('metric', p, 'nobody.com', 'msgs').stdout, '0\n');
  assert.equal(run('metric', p, 'nobody.com', 'pass-pct').stdout, '100\n');
  assert.equal(run('metric', join(tmp(), 'missing.jsonl'), 'a.com', 'msgs').stdout, '0\n');
  assert.equal(run('metric', join(tmp(), 'missing.jsonl'), 'a.com', 'unknown-ips', '--expected', '1.1.1.1').stdout, '0\n');
  const noExp = run('metric', p, 'a.com', 'unknown-ips');
  assert.equal(noExp.status, 1); assert.match(noExp.stderr, /--expected/);
  assert.equal(run('metric', p, 'a.com', 'bogus').status, 1);
  assert.equal(run('metric', p, 'a.com', 'msgs', '--days', 'x').status, 1);
  assert.equal(run('metric', p, 'a.com', 'unknown-ips', '--expected', 'not-an-ip').status, 1);
});

test('check: silent + exit 0 when green', () => {
  const p = history([['a.com', 1, [S('203.0.113.7', 10)]]]);
  const r = run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('check: signing broke (fail from an expected source), with --max-fail threshold', () => {
  const p = history([['a.com', 1, [S('203.0.113.7', 12, 'fail', 'fail'), S('203.0.113.7', 3)]]]);
  const r = run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'a.com: 12 DMARC-fail msgs from expected 203.0.113.7 (signing broke?)\n');
  assert.equal(run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7', '--max-fail', '12').status, 0);
  assert.equal(run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7', '--max-fail', '11').status, 1);
});

test('check: unexpected source counts pass AND fail mail; one line per problem; --max-unknown; other domains untouched', () => {
  const p = history([
    ['a.com', 1, [S('203.0.113.7', 4), S('198.51.100.9', 2), S('198.51.100.10', 1, 'fail', 'fail')]],
    ['b.com', 1, [S('203.0.113.7', 4)]],
  ]);
  const r = run('check', p, '--domains', 'a.com,b.com', '--expected', '203.0.113.7');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'a.com: 3 msgs from unexpected 198.51.100.9, 198.51.100.10 (unexpected source)\n');
  assert.equal(run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7', '--max-unknown', '3').status, 0);
  // an unexpected failing source is "unexpected", not "signing broke"
  assert.doesNotMatch(r.stderr, /signing broke/);
});

test('check: window excludes old reports; usage errors exit 1', () => {
  const p = history([['a.com', 20, [S('198.51.100.9', 5, 'fail', 'fail')]]]);
  assert.equal(run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7').status, 0);
  assert.equal(run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7', '--days', '30').status, 1);
  assert.equal(run('check', p, '--domains', 'a.com').status, 1);
  assert.equal(run('check', p, '--expected', '1.1.1.1').status, 1);
});

test('CIDR: v4 /24 boundary, v6 /64, bare IPs, IPv4-mapped', () => {
  const ips = ['10.1.2.0', '10.1.2.255', '10.1.3.0', '10.1.1.255', '2001:db8:0:1::5', '2001:db8:0:1:ffff::1', '2001:db8:0:2::1', '192.0.2.1', '192.0.2.2', '::ffff:10.1.2.9'];
  const p = history([['a.com', 1, ips.map((ip) => S(ip, 1))]]);
  const unknown = (exp) => Number(run('metric', p, 'a.com', 'unknown-ips', '--expected', exp).stdout);
  assert.equal(unknown('10.1.2.0/24'), 10 - 3); // .0, .255 and the mapped .9 are in
  assert.equal(unknown('2001:db8:0:1::/64'), 10 - 2);
  assert.equal(unknown('192.0.2.1'), 9); // bare v4 = /32
  assert.equal(unknown('2001:db8:0:1::5'), 9); // bare v6 = /128
  assert.equal(unknown('0.0.0.0/0,::/0'), 0);
  assert.equal(run('metric', p, 'a.com', 'unknown-ips', '--expected', '10.0.0.0/33').status, 1);
});

test('check: stdout stays empty on a problem (the alert reads stderr)', () => {
  const p = history([['a.com', 1, [S('198.51.100.9', 2)]]]);
  const r = run('check', p, '--domains', 'a.com', '--expected', '203.0.113.7');
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unexpected source/);
});

test('end to end: a pulselog command check running `dmarc check` carries the problem into the health record', async () => {
  const p = history([['a.com', 1, [S('198.51.100.9', 2)]]]);
  const dir = tmp();
  const out = join(dir, 'health.jsonl');
  const cfg = (expected) => {
    const f = join(dir, `cfg-${expected.replace(/\W/g, '')}.json`);
    writeFileSync(f, JSON.stringify({ output: { file: out, maxBytes: 0 }, checks: [{ type: 'command', name: 'dmarc', command: process.execPath,
      args: [SCRIPT, 'check', p, '--domains', 'a.com', '--expected', expected] }] }));
    return f;
  };
  assert.deepEqual(await healthRun({ configPath: cfg('198.51.100.9') }), { total: 1, failures: 0, deliveryFailed: false });
  assert.equal(existsSync(out), false, 'silent on green');
  assert.equal((await healthRun({ configPath: cfg('203.0.113.7') })).failures, 1);
  const [rec] = lines(out);
  assert.equal(rec.name, 'dmarc');
  assert.match(rec.message, /unexpected source/);
  assert.match(rec.message, /198\.51\.100\.9/);
});

// ---- hostile input ----
test('ingest: a decompression bomb (gzip of 21 MB of zeros) goes to bad/ as "report too large"; the run survives', () => {
  const { dir, out } = inbox({
    bomb: multipart('Content-Type: application/gzip; name="r.xml.gz"\r\nContent-Transfer-Encoding: base64', b64(gzipSync(Buffer.alloc(21 * 1024 * 1024)))),
    ok: zipMail(zip(xml({ id: 'fine' }))),
  });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'dmarc ingest: 1 new, 0 duplicate, 1 bad\n');
  assert.deepEqual(names(dir, 'bad'), ['bomb']);
  const err = lines(out).find((l) => l.kind === 'dmarc-error');
  assert.equal(err.file, 'bomb');
  assert.match(err.reason, /too large/);
});

test('ingest: a message file over 25 MB is sent to bad/ unread', () => {
  const { dir, out } = inbox({ huge: Buffer.alloc(26 * 1024 * 1024, 65) });
  assert.equal(run('ingest', dir, out).stdout, 'dmarc ingest: 0 new, 0 duplicate, 1 bad\n');
  assert.deepEqual(names(dir, 'bad'), ['huge']);
  assert.match(lines(out)[0].reason, /message too large/);
});

test('ingest: dmarc.jsonl inside a plain <dir> is a usage error and is not moved', () => {
  const { dir } = inbox({ 'a.eml': zipMail(zip(xml())) });
  const inside = join(dir, 'dmarc.jsonl');
  writeFileSync(inside, '');
  const r = run('ingest', dir, inside);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside/);
  assert.ok(existsSync(inside));
  assert.deepEqual(names(dir, 'bad'), []);
  assert.ok(existsSync(join(dir, 'a.eml')), 'nothing was processed');
});

test('ingest: 80,000 unterminated <record> tags are ingested in linear time (was quadratic, ~77 s)', () => {
  const hostile = xml({ id: 'hostile', rows: [] }).replace('</feedback>', `${'<record>'.repeat(80000)}</feedback>`);
  const { dir, out } = inbox({ m: `Content-Type: text/xml\r\n\r\n${hostile}` });
  const t0 = Date.now();
  const r = run('ingest', dir, out);
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
  assert.ok(ms < 15000, `took ${ms} ms (linear is ~0.3 s alone; the quadratic version took ~77 s)`);
});

test('ingest: a pre-existing 0644 jsonl is tightened to 0600', () => {
  const { dir, out } = inbox({ m: zipMail(zip(xml())) });
  writeFileSync(out, '');
  chmodSync(out, 0o644);
  assert.equal(run('ingest', dir, out).status, 0);
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test('ingest: a symlinked jsonl pointing into a plain <dir> is a usage error and nothing is moved', () => {
  const { dir } = inbox({ 'a.eml': zipMail(zip(xml())) });
  const real = join(dir, 'dmarc.jsonl');
  writeFileSync(real, '');
  const link = join(ROOT, `${seq++}-link.jsonl`);
  symlinkSync(real, link);
  const r = run('ingest', dir, link);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside/);
  assert.ok(existsSync(real) && existsSync(join(dir, 'a.eml')));
  assert.deepEqual(names(dir, 'bad'), []);
  // a not-yet-existing out under a symlinked parent dir that resolves into <dir>
  const parent = join(ROOT, `${seq++}-parent`);
  symlinkSync(dir, parent);
  const r2 = run('ingest', dir, join(parent, 'new.jsonl'));
  assert.equal(r2.status, 1);
  assert.deepEqual(names(dir, 'bad'), []);
});

test('ingest: a jsonl inside a Maildir new/ or cur/ (also via symlink) is a usage error, nothing moved; root and logs/ are fine', () => {
  const { dir } = inbox({ 'a.eml': zipMail(zip(xml())) }, { maildir: true });
  const inNew = join(dir, 'new', 'd.jsonl');
  const r = run('ingest', dir, inNew);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside/);
  assert.deepEqual(names(dir, 'new'), ['a.eml']);
  assert.deepEqual(names(dir, 'bad'), []);
  assert.ok(!existsSync(inNew));
  const real = join(dir, 'cur', 'd.jsonl');
  writeFileSync(real, '');
  const link = join(ROOT, `${seq++}-mdlink.jsonl`);
  symlinkSync(real, link);
  const r2 = run('ingest', dir, link);
  assert.equal(r2.status, 1);
  assert.deepEqual(names(dir, 'bad'), []);
  assert.deepEqual(names(dir, 'new'), ['a.eml']);
  rmSync(real); // the refused stand-in would itself be read as a message
  const r3 = run('ingest', dir, join(dir, 'dmarc.jsonl'));
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(r3.stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
  mkdirSync(join(dir, 'logs'));
  assert.equal(run('ingest', dir, join(dir, 'logs', 'dmarc.jsonl')).status, 0);
});

test('ingest: overlapping runs (3 at once over 1,500 messages) all exit 0, record no dmarc-error, lose no report', async () => {
  const files = {};
  for (let i = 0; i < 1500; i++) files[`m${i}`] = `Content-Type: text/xml\r\n\r\n${xml({ id: `r${i}` })}`;
  const { dir, out } = inbox(files);
  const go = () => new Promise((res) => {
    const c = spawn(process.execPath, [SCRIPT, 'ingest', dir, out]);
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => res({ status, stderr }));
  });
  const results = await Promise.all([go(), go(), go()]);
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const ls = lines(out);
  assert.equal(ls.filter((l) => l.kind === 'dmarc-error').length, 0);
  assert.equal(new Set(ls.filter((l) => l.kind === 'dmarc').map((l) => l.report_id)).size, 1500); // none lost (duplicate lines on disk are allowed)
  assert.equal(names(dir, 'done').length, 1500);
  // ...and whatever duplicates the overlap wrote, readers count each report once: 1,500 reports x 3 msgs
  const m = run('metric', out, 'example.com', 'msgs');
  assert.equal(m.stdout.trim(), '4500');
  // check: all 4,500 msgs are from an unexpected IP; --max-unknown 4500 is silent only if nothing is inflated
  const c = run('check', out, '--domains', 'example.com', '--expected', '198.51.100.1', '--max-unknown', '4500');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stderr, '');
});

test('metric/check: the same report written twice in the JSONL counts once', () => {
  const rec = { kind: 'dmarc', domain: 'example.com', org: 'google.com', report_id: 'dup', end: new Date((NOW - DAY) * 1000).toISOString(), msgs: 3, fail: 1, sources: [{ ip: '198.51.100.9', count: 3, dkim: 'fail', spf: 'fail' }] };
  const out = join(ROOT, `${seq++}.jsonl`);
  writeFileSync(out, [rec, rec, { ...rec, org: 'yahoo.com' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(run('metric', out, 'example.com', 'msgs').stdout.trim(), '6'); // google once + yahoo (other org, same id) once; 9 if not deduped
  // failing msgs from the expected IP: 3 + 3 = 6 deduped (9 if not): --max-fail 6 passes only when deduped
  const c = run('check', out, '--domains', 'example.com', '--expected', '198.51.100.9', '--max-fail', '6');
  assert.equal(c.status, 0, c.stderr);
});

test('ingest: a multipart whose earlier part has a report-looking name but is not a report still finds the real one', () => {
  const mp = (parts) => `From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="BND"\r\n\r\n${parts.map((p) => `--BND\r\n${p}\r\n`).join('')}--BND--\r\n`;
  const real = `Content-Type: text/xml\r\n\r\n${xml({ id: 'real' })}`;
  const { dir, out } = inbox({
    notes: mp(['Content-Type: text/plain; name="notes.xml"\r\n\r\njust some words', real]),
    sig: mp(['Content-Type: application/pgp-signature; name="report.xml"\r\n\r\n-----BEGIN PGP SIGNATURE-----', real.replace('real', 'real2')]),
  });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'dmarc ingest: 2 new, 0 duplicate, 0 bad\n');
  assert.deepEqual(names(dir, 'bad'), []);
  assert.deepEqual(lines(out).map((l) => l.report_id).sort(), ['real', 'real2']);
});

test('ingest: when no candidate part is a report, the first candidate\'s error is recorded; the size limit holds for every attempt', () => {
  const mp = (parts) => `From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="BND"\r\n\r\n${parts.map((p) => `--BND\r\n${p}\r\n`).join('')}--BND--\r\n`;
  const bomb = `Content-Type: application/gzip; name="b.gz"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(gzipSync(Buffer.alloc(21 * 1024 * 1024)))}`;
  const { dir, out } = inbox({
    two: mp(['Content-Type: text/plain; name="a.xml"\r\n\r\nnope', 'Content-Type: text/plain; name="b.xml"\r\n\r\nalso nope']),
    bomb: mp([bomb, 'Content-Type: text/plain; name="b.xml"\r\n\r\nnope']),
  });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'dmarc ingest: 0 new, 0 duplicate, 2 bad\n');
  const reasons = Object.fromEntries(lines(out).map((l) => [l.file, l.reason]));
  assert.equal(reasons.two, 'not a DMARC aggregate report');
  assert.equal(reasons.bomb, 'report too large'); // first candidate's error, not the later "not a DMARC aggregate report"
});

test('ingest: the decompression budget is per MESSAGE: 50 parts that each inflate to ~20 MB are rejected fast, and a real report after them is not reached', () => {
  const mp = (parts) => `From: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="BND"\r\n\r\n${parts.map((p) => `--BND\r\n${p}\r\n`).join('')}--BND--\r\n`;
  const gz = b64(gzipSync(Buffer.alloc(20 * 1024 * 1024 - 1000, 0x20))); // just under the 20 MB cap: each part is individually legal
  const bomb = `Content-Type: application/gzip; name="b.xml.gz"\r\nContent-Transfer-Encoding: base64\r\n\r\n${gz}`;
  const real = `Content-Type: text/xml\r\n\r\n${xml({ id: 'late' })}`;
  const { dir, out } = inbox({ many: mp([...Array(50).fill(bomb), real]) });
  const t0 = Date.now();
  const r = run('ingest', dir, out);
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'dmarc ingest: 0 new, 0 duplicate, 1 bad\n'); // per-attempt cap would have inflated all 50 (~12 s), then ingested 'late'
  assert.equal(lines(out).find((l) => l.kind === 'dmarc-error').reason, 'report too large');
  assert.ok(ms < 10000, `took ${ms} ms`);
});

test('ingest: <dir>/bad being a plain file: junk is not moved, exit 1, stderr names it, one dmarc-error per run (no more)', () => {
  const { dir, out } = inbox({ junk: 'not mail at all' });
  writeFileSync(join(dir, 'bad'), 'i am a file');
  for (const n of [1, 2]) {
    const r = run('ingest', dir, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dmarc ingest: could not move junk to bad\/: /);
    assert.equal(r.stdout, 'dmarc ingest: 0 new, 0 duplicate, 1 bad\n');
    // The stuck file is re-parsed every run, so each run adds exactly one parse-error line (n lines after n runs): never two per run.
    assert.equal(lines(out).filter((l) => l.kind === 'dmarc-error').length, n);
  }
  assert.ok(existsSync(join(dir, 'junk')));
  assert.equal(readFileSync(join(dir, 'bad'), 'utf8'), 'i am a file'); // the file named bad is never ingested as mail
});

test('ingest: in a plain dir, files named done or bad are not messages', () => {
  const { dir, out } = inbox({ done: zipMail(zip(xml({ id: 'a' }))), bad: zipMail(zip(xml({ id: 'b' }))) });
  const r = run('ingest', dir, out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'dmarc ingest: 0 new, 0 duplicate, 0 bad\n');
  assert.equal(readFileSync(out, 'utf8'), '');
});

test('ingest: a read-only dir: the good report is recorded once as dmarc, no dmarc-error, exit 1', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, () => {
  const { dir, out } = inbox({ good: zipMail(zip(xml({ id: 'ro' }))) });
  chmodSync(dir, 0o555);
  try {
    const r = run('ingest', dir, out);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not move good to done\/: /);
    assert.equal(r.stdout, 'dmarc ingest: 1 new, 0 duplicate, 0 bad\n');
    assert.deepEqual(lines(out).map((l) => l.kind), ['dmarc']);
    // next run sees it again: a duplicate (not a second record), still exit 1
    const r2 = run('ingest', dir, out);
    assert.equal(r2.status, 1);
    assert.equal(r2.stdout, 'dmarc ingest: 0 new, 1 duplicate, 0 bad\n');
    assert.equal(lines(out).length, 1);
  } finally { chmodSync(dir, 0o755); }
});
