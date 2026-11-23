#!/usr/bin/env node
// pulselog DMARC example — turn the aggregate (RUA) reports that Google, Microsoft, Yahoo...
// mail you into a JSONL file, then feed pulselog a digest metric and a health check from it.
// Zero dependencies (node:* only), no network. This is an example, not library code: copy it,
// bend it. pulselog owns the shape; this file owns the DMARC-specific parts.
//
//   node dmarc.mjs ingest <dir> <dmarc.jsonl>
//       <dir> is a Maildir (new/ + cur/) or a plain folder of message files. Each message's
//       report (zip / gzip / plain XML, bare or inside multipart) is parsed and ONE line is
//       appended. Handled mail moves to <dir>/done/, unparseable mail to <dir>/bad/ (plus a
//       {"kind":"dmarc-error"} line). Re-delivered reports (same org + report_id) are skipped.
//       Keep dmarc.jsonl OUTSIDE a plain <dir> (it would be ingested as mail; refused).
//       Oversized messages (>25 MB) and messages whose reports decompress past 20 MB in total go to bad/.
//   node dmarc.mjs metric <dmarc.jsonl> <domain> <msgs|pass-pct|unknown-ips>
//                         [--expected ip/cidr,...] [--days 7]
//       Prints ONE integer for the last N days (reports are counted by their end date).
//       pass-pct = round(100 * (msgs - fail) / msgs); 100 when there was no mail (nothing failed).
//       unknown-ips = distinct source IPs outside --expected (required for this metric).
//   node dmarc.mjs check <dmarc.jsonl> --domains a.com,b.com --expected ip/cidr,...
//                         [--days 7] [--max-fail 0] [--max-unknown 0]
//       Silent + exit 0 when fine. Otherwise one line per problem on STDERR (what a pulselog
//       command check puts in its alert) and exit 1:
//         "signing broke"      — DMARC-failing mail from an EXPECTED source (> --max-fail)
//         "unexpected source"  — any mail from an IP outside --expected (> --max-unknown)
//
// DMARC passes when EITHER aligned DKIM or aligned SPF passes, so a message "fails" only when
// both are not-pass. Exit codes: ingest/metric exit 0 on a normal run (bad mail is reported,
// not fatal); everything exits 1 on bad arguments or an unreadable path, and ingest also exits 1
// when it cannot move a processed message to done/ or bad/.
//
// Wire it into pulselog (point a mail rule / fetchmail / procmail at ~/dmarc-inbox, ingest
// from the same cron or a systemd timer before pulselog runs):
//   digest.metrics:
//     { "name": "dmarc msgs",  "command": "node", "args": ["/opt/dmarc.mjs", "metric", "/var/lib/pulselog/dmarc.jsonl", "example.com", "msgs"] }
//     { "name": "dmarc pass%", "command": "node", "args": ["/opt/dmarc.mjs", "metric", "/var/lib/pulselog/dmarc.jsonl", "example.com", "pass-pct"] }
//   checks:
//     { "type": "command", "name": "dmarc", "command": "node",
//       "args": ["/opt/dmarc.mjs", "check", "/var/lib/pulselog/dmarc.jsonl", "--domains", "example.com", "--expected", "203.0.113.7,2001:db8::/64"] }
//   (ingest itself is just a cron line: node /opt/dmarc.mjs ingest ~/Maildir /var/lib/pulselog/dmarc.jsonl)
import { readFileSync, readdirSync, statSync, mkdirSync, renameSync, appendFileSync, existsSync, openSync, closeSync, realpathSync, chmodSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { BlockList, isIP } from 'node:net';

const MAX_REPORT = 20 * 1024 * 1024; // decompressed bytes: anyone can mail the rua address
const MAX_MESSAGE = 25 * 1024 * 1024; // raw message file bytes

const USAGE = `usage:
  dmarc.mjs ingest <dir> <dmarc.jsonl>
  dmarc.mjs metric <dmarc.jsonl> <domain> <msgs|pass-pct|unknown-ips> [--expected ip/cidr,...] [--days 7]
  dmarc.mjs check <dmarc.jsonl> --domains a,b --expected ip/cidr,... [--days 7] [--max-fail 0] [--max-unknown 0]`;

class UsageError extends Error {}
class ParseError extends Error {}

// ---------- message -> XML ----------

// RFC 5322 headers: continuation lines (leading space/tab) are folded into the previous one.
function parseHeaders(text) {
  const h = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return h;
}

function splitEntity(buf) { // headers / body at the first blank line
  const m = /\r?\n\r?\n/.exec(buf.toString('latin1'));
  const at = m ? m.index : buf.length;
  return {
    headers: parseHeaders(buf.subarray(0, at).toString('latin1')),
    body: buf.subarray(at + (m ? m[0].length : 0)),
  };
}

const param = (value = '', name) =>
  new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value)?.slice(1).find(Boolean);

const GOOD_TYPES = ['application/zip', 'application/gzip', 'application/x-gzip', 'text/xml', 'application/xml',
  'application/x-zip-compressed', 'application/x-zip'];

function acceptable(headers) {
  const type = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
  const name = param(headers['content-type'], 'name') || param(headers['content-disposition'], 'filename') || '';
  return GOOD_TYPES.includes(type) || /\.(zip|gz|xml)$/i.test(name); // any label is fine with such a name: reportXml() sniffs the bytes
}

// Transfer-decode a body to bytes.
function decodeBody(headers, body) {
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase();
  const text = body.toString('latin1');
  if (cte === 'base64') {
    if (/[^A-Za-z0-9+/=\s]/.test(text)) throw new ParseError('bad base64');
    return Buffer.from(text, 'base64');
  }
  if (cte === 'quoted-printable') {
    return Buffer.from(text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))), 'latin1');
  }
  if (cte === '7bit' || cte === '8bit' || cte === 'binary') return body;
  throw new ParseError(`unsupported transfer encoding ${cte}`);
}

// Candidate report entities, in order: the message itself, or every acceptable part of a multipart/*
// (a text/plain or signature part may carry a .xml-ish name, so messageReport() tries each in turn).
function findPayloads(raw) {
  const top = splitEntity(raw);
  const ct = top.headers['content-type'] || '';
  if (/^\s*multipart\//i.test(ct)) {
    const boundary = param(ct, 'boundary');
    if (!boundary) throw new ParseError('multipart without boundary');
    const body = top.body.toString('latin1');
    const found = [];
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break; // closing delimiter
      const e = splitEntity(Buffer.from(part.replace(/^[ \t]*\r?\n/, ''), 'latin1'));
      if (acceptable(e.headers)) found.push(e);
    }
    if (!found.length) throw new ParseError('no DMARC report part');
    return found;
  }
  if (!acceptable(top.headers)) throw new ParseError(`unsupported content type ${ct.split(';')[0].trim() || '(none)'}`);
  return [top];
}

// First entry of a zip, from its local file header. Bit 3 of the flags means the sizes live in
// a data descriptor *after* the data, so the header says 0 — then read the compressed size from
// the central directory (found via the end-of-central-directory record).
function unzipFirst(b, budget) {
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) throw new ParseError('not a zip');
  const flags = b.readUInt16LE(6);
  const method = b.readUInt16LE(8);
  let size = b.readUInt32LE(18);
  const start = 30 + b.readUInt16LE(26) + b.readUInt16LE(28);
  if (flags & 8 && size === 0) {
    let e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new ParseError('truncated zip');
    const cd = b.readUInt32LE(e + 16);
    if (cd + 24 > b.length || b.readUInt32LE(cd) !== 0x02014b50) throw new ParseError('truncated zip');
    size = b.readUInt32LE(cd + 20);
  }
  if (start + size > b.length) throw new ParseError('truncated zip');
  const data = b.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return bounded(() => inflateRawSync(data, { maxOutputLength: budget.left }), budget);
  throw new ParseError(`unsupported zip method ${method}`);
}

// A decompression bomb trips maxOutputLength (RangeError): make it an ordinary bad message.
// The budget is the message's TOTAL decompressed bytes: charge what was produced; a bomb eats it all.
function bounded(inflate, budget) {
  if (budget.left <= 0) throw new ParseError('report too large'); // spent: never ask zlib for a 0 limit (it throws RangeError)
  try { const out = inflate(); budget.left -= out.length; return out; } catch (err) {
    if (err instanceof RangeError) { budget.left = 0; throw new ParseError('report too large'); }
    throw err;
  }
}

function payloadXml({ headers, body }, budget) {
  let bytes = decodeBody(headers, body);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) bytes = unzipFirst(bytes, budget);
  else if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = bounded(() => gunzipSync(bytes, { maxOutputLength: budget.left }), budget);
  return bytes.toString('utf8');
}

// message -> report record: the first candidate part that decodes AND parses as an aggregate
// report wins; if none does, the first candidate's error is the one reported.
function messageReport(raw) {
  let first;
  const budget = { left: MAX_REPORT }; // one decompression budget per message, not per attempt
  for (const payload of findPayloads(raw)) {
    try { return parseReport(payloadXml(payload, budget)); } catch (err) { first ??= err; }
  }
  throw first;
}

// ---------- XML -> record ----------

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ENTITIES[e]);

// Inner text of each <name>...</name> (any namespace prefix / attributes), in order. Linear scan: a
// regex with a lazy body goes quadratic on many unterminated tags, and the rua address is public.
function* elements(xml, name) {
  const open = new RegExp(`<(?:\\w+:)?${name}(?=[\\s>])`, 'g');
  const close = new RegExp(`</(?:\\w+:)?${name}>`, 'g');
  for (let m; (m = open.exec(xml)); ) {
    const gt = xml.indexOf('>', open.lastIndex);
    if (gt < 0) return;
    close.lastIndex = gt + 1;
    const end = close.exec(xml);
    if (!end) return; // no close tag after here, so none for any later open either
    yield xml.slice(gt + 1, end.index);
    open.lastIndex = close.lastIndex;
  }
}

// Inner text of the first <name>...</name>, or undefined.
function tag(xml, name) {
  for (const inner of elements(xml, name)) return unescapeXml(inner.trim());
  return undefined;
}

const toIso = (secs) => (Number.isFinite(+secs) && secs ? new Date(+secs * 1000).toISOString() : null);

// RFC 7489 aggregate report -> the JSONL line (minus ts/kind).
function parseReport(xml) {
  if (!/<(?:\w+:)?feedback[\s>]/.test(xml)) throw new ParseError('not a DMARC aggregate report');
  const org = tag(xml, 'org_name');
  const reportId = tag(xml, 'report_id');
  const published = tag(xml, 'policy_published') || '';
  const domain = tag(published, 'domain');
  if (!org || !reportId || !domain) throw new ParseError('report missing org_name/report_id/domain');
  const sources = [];
  for (const rec of elements(xml, 'record')) {
    const row = tag(rec, 'row') || '';
    const ev = tag(row, 'policy_evaluated') || '';
    sources.push({
      ip: tag(row, 'source_ip') || '',
      count: parseInt(tag(row, 'count'), 10) || 0,
      dkim: tag(ev, 'dkim') || 'none',
      spf: tag(ev, 'spf') || 'none',
      disposition: tag(ev, 'disposition') || 'none',
    });
  }
  const sum = (pred) => sources.filter(pred).reduce((n, s) => n + s.count, 0);
  const range = tag(xml, 'date_range') || '';
  return {
    domain, org, report_id: reportId,
    begin: toIso(tag(range, 'begin')), end: toIso(tag(range, 'end')),
    p: tag(published, 'p') || null,
    msgs: sum(() => true),
    dkim_aligned: sum((s) => s.dkim === 'pass'),
    spf_aligned: sum((s) => s.spf === 'pass'),
    fail: sum((s) => s.dkim !== 'pass' && s.spf !== 'pass'),
    sources,
  };
}

// ---------- ingest ----------

const readLines = (path) => {
  if (!existsSync(path)) return [];
  const out = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    try { out.push(JSON.parse(l)); } catch { /* blank or damaged line: ignore */ }
  }
  return out;
};

const isMaildir = (dir) => existsSync(join(dir, 'new')) || existsSync(join(dir, 'cur'));

const readDirs = (dir) => (isMaildir(dir) ? ['new', 'cur'].map((d) => join(dir, d)).filter(existsSync) : [dir]); // the dirs ingest reads

function listMessages(dir) {
  const own = (d, name) => d === dir && (name === 'done' || name === 'bad'); // never ingest our own sub-dir names, even as files
  return readDirs(dir).flatMap((d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && !own(d, e.name)).map((e) => join(d, e.name)));
}

function moveTo(dir, sub, file) {
  mkdirSync(join(dir, sub), { recursive: true });
  let dest = join(dir, sub, basename(file));
  if (existsSync(dest)) dest = join(dir, sub, `${Date.now()}-${basename(file)}`);
  renameSync(file, dest);
}

function ingest([dir, out]) {
  if (!dir || !out) throw new UsageError('ingest needs <dir> <dmarc.jsonl>');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  { // compare real paths: a symlinked out must not slip into a dir ingest reads
    const outReal = existsSync(out) ? realpathSync(out) : join(realpathSync(dirname(resolve(out))), basename(out));
    if (readDirs(dir).some((d) => realpathSync(d) === dirname(outReal))) throw new UsageError('keep dmarc.jsonl outside <dir> (it would be ingested as a message)');
  }
  closeSync(openSync(out, 'a', 0o600)); // create 0600 up front; throws if unwritable
  chmodSync(out, 0o600); // the mode above only applies on create
  const seen = new Set(readLines(out).filter((l) => l.kind === 'dmarc').map((l) => `${l.org}\0${l.report_id}`));
  const append = (obj) => appendFileSync(out, JSON.stringify(obj) + '\n');
  let added = 0, dup = 0, bad = 0;
  const moved = (file, sub) => { // a move failure is not a parse failure: report it, exit 1, keep going
    try { moveTo(dir, sub, file); } catch (e) {
      if (e.code === 'ENOENT') return; // another run already moved it
      console.error(`dmarc ingest: could not move ${basename(file)} to ${sub}/: ${e.message}`);
      process.exitCode = 1;
    }
  };
  for (const file of listMessages(dir)) {
    let rec;
    try {
      if (statSync(file).size > MAX_MESSAGE) throw new ParseError('message too large');
      rec = messageReport(readFileSync(file));
    } catch (err) {
      if (err.code === 'ENOENT' && !existsSync(file)) continue; // another run already moved it
      bad++;
      append({ ts: new Date().toISOString(), kind: 'dmarc-error', file: basename(file), reason: String(err.message).slice(0, 120) });
      moved(file, 'bad');
      continue;
    }
    const key = `${rec.org}\0${rec.report_id}`;
    if (seen.has(key)) dup++;
    else {
      seen.add(key);
      append({ ts: new Date().toISOString(), kind: 'dmarc', ...rec });
      added++;
    }
    moved(file, 'done');
  }
  console.log(`dmarc ingest: ${added} new, ${dup} duplicate, ${bad} bad`);
}

// ---------- metric / check ----------

// ip/cidr list -> (ip) => boolean. node:net BlockList covers v4 and v6; a bare IP is /32 or /128.
function matcher(list) {
  const bl = new BlockList();
  for (const item of (list || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = item.split('/');
    const fam = isIP(addr);
    const max = fam === 4 ? 32 : 128;
    const n = bits === undefined ? max : Number(bits);
    if (!fam || !Number.isInteger(n) || n < 0 || n > max) throw new UsageError(`bad ip/cidr: ${item}`);
    bl.addSubnet(addr, n, fam === 4 ? 'ipv4' : 'ipv6');
  }
  return (ip) => {
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]; // IPv4-mapped IPv6 -> plain IPv4
    const addr = v4 || ip;
    const fam = isIP(addr);
    return fam !== 0 && bl.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
  };
}

function parseFlags(args, known) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { pos.push(args[i]); continue; }
    const name = args[i].slice(2);
    if (!known.includes(name) || args[i + 1] === undefined) throw new UsageError(`bad or incomplete option ${args[i]}`);
    flags[name] = args[++i];
  }
  return { pos, flags };
}

const num = (v, name, dflt) => {
  if (v === undefined) return dflt;
  if (!/^\d+(\.\d+)?$/.test(v) || (name === 'days' && +v === 0)) throw new UsageError(`bad --${name}: ${v}`);
  return Number(v);
};

// Reports whose end falls within the last `days`; errors and other kinds are ignored; duplicates collapse.
function recent(path, days) {
  const since = Date.now() - days * 86400000;
  const seen = new Set(); // overlapping ingests may write a report twice: count each org+report_id once
  const first = (l) => { const k = `${l.org}\0${l.report_id}`; return !seen.has(k) && seen.add(k); };
  return readLines(path).filter((l) => l.kind === 'dmarc' && first(l) && Date.parse(l.end) >= since);
}

function metric(args) {
  const { pos: [path, domain, which], flags } = parseFlags(args, ['expected', 'days']);
  if (!path || !domain || !['msgs', 'pass-pct', 'unknown-ips'].includes(which)) throw new UsageError('metric needs <dmarc.jsonl> <domain> <msgs|pass-pct|unknown-ips>');
  if (which === 'unknown-ips' && !flags.expected) throw new UsageError('unknown-ips needs --expected');
  const isExpected = matcher(flags.expected);
  const reports = recent(path, num(flags.days, 'days', 7)).filter((r) => r.domain === domain);
  const msgs = reports.reduce((n, r) => n + r.msgs, 0);
  const fail = reports.reduce((n, r) => n + r.fail, 0);
  if (which === 'msgs') console.log(msgs);
  else if (which === 'pass-pct') console.log(msgs === 0 ? 100 : Math.round((100 * (msgs - fail)) / msgs));
  else console.log(new Set(reports.flatMap((r) => r.sources.map((s) => s.ip)).filter((ip) => !isExpected(ip))).size);
}

function check(args) {
  const { pos, flags } = parseFlags(args, ['domains', 'expected', 'days', 'max-fail', 'max-unknown']);
  if (pos.length !== 1 || !flags.domains || !flags.expected) throw new UsageError('check needs <dmarc.jsonl> --domains a,b --expected ip/cidr,...');
  const isExpected = matcher(flags.expected);
  const days = num(flags.days, 'days', 7), maxFail = num(flags['max-fail'], 'max-fail', 0), maxUnknown = num(flags['max-unknown'], 'max-unknown', 0);
  const reports = recent(pos[0], days);
  const problems = [];
  for (const domain of flags.domains.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sources = reports.filter((r) => r.domain === domain).flatMap((r) => r.sources);
    const failing = sources.filter((s) => isExpected(s.ip) && s.dkim !== 'pass' && s.spf !== 'pass');
    const unknown = sources.filter((s) => !isExpected(s.ip));
    const sum = (list) => list.reduce((n, s) => n + s.count, 0);
    const ips = (list) => [...new Set(list.map((s) => s.ip))].slice(0, 3).join(', ');
    if (sum(failing) > maxFail) problems.push(`${domain}: ${sum(failing)} DMARC-fail msgs from expected ${ips(failing)} (signing broke?)`);
    if (sum(unknown) > maxUnknown) problems.push(`${domain}: ${sum(unknown)} msgs from unexpected ${ips(unknown)} (unexpected source)`);
  }
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; } // stderr: what a pulselog command check shows in the alert
}

// ---------- main ----------

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'ingest') ingest(rest);
  else if (cmd === 'metric') metric(rest); // a missing JSONL reads as no reports
  else if (cmd === 'check') check(rest);
  else throw new UsageError(cmd ? `unknown subcommand ${cmd}` : 'missing subcommand');
} catch (err) {
  if (err instanceof UsageError) console.error(`${err.message}\n${USAGE}`);
  else console.error(`dmarc: ${err.message}`);
  process.exitCode = 1;
}
