// Digest primitives — the `checks.js` analogue for stats. Each piece is small,
// pure where it can be, and never throws (a broken metric returns null; the
// orchestrator in digest.js guards too). Zero deps: `node:*` only. pulselog owns
// the *shape* (collect → snapshot → WoW → render); the adopter owns *which* numbers,
// via the config `metrics` list. A metric is a `command` that prints one integer —
// the same escape hatch as the health `command` check, so the app-specific logic
// (a SQL `count(distinct …)`) lives in the adopter's query, never here.
import { spawnSync } from 'node:child_process';

const DAY = 86_400_000;

/**
 * Coerce a value to a whole number, or `null`. Only numbers and numeric strings
 * qualify — `true`/`[]`/`{}`/`null` are rejected (so a stray JSON bool can't become
 * `1`, and `Number([])===0` can't sneak a zero in). The one shared gate every metric
 * value passes through, single-command or batch.
 * @param {unknown} v
 * @returns {number | null}
 */
function asInteger(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/**
 * Run one metric command and return a single integer, or `null` if it failed,
 * timed out, or printed something that isn't a whole number. Never throws.
 * @param {{ command: string, args?: string[], timeoutMs?: number }} metric
 * @returns {number | null}
 */
export function runMetric({ command, args = [], timeoutMs = 10_000 }) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  if (r.error || r.status !== 0) return null;
  return asInteger(String(r.stdout).trim());
}

/**
 * Run ONE command that prints a JSON object of named integers, amortizing an
 * expensive snapshot pass (e.g. ~14 metrics computed in a single scan instead of
 * one spawn per metric). Returns the parsed flat object as-printed — per-name
 * integer validation happens later, in `resolveMetric`, so this stays the same
 * "store only what you declared" contract. Returns `null` if the command failed,
 * timed out, or stdout wasn't a JSON object (an array/scalar doesn't qualify).
 * Never throws.
 * @param {{ command: string, args?: string[], timeoutMs?: number }} batch
 * @returns {Record<string, unknown> | null}
 */
export function runMetricsBatch({ command, args = [], timeoutMs = 10_000 }) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  if (r.error || r.status !== 0) return null;
  let obj;
  try { obj = JSON.parse(String(r.stdout).trim()); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj;
}

/**
 * Resolve one declared metric to its integer value (or `null`). A metric with its
 * own `command` is spawned (back-compatible, one command → one integer); otherwise
 * its value is read **by name** from a pre-run `batch` object (from
 * `runMetricsBatch`). Either path enforces the same whole-number gate, and only
 * declared names are ever read — pulselog still stores nothing you didn't ask for.
 * @param {{ name: string, command?: string, args?: string[], timeoutMs?: number }} metric
 * @param {Record<string, unknown> | null} [batch]
 * @returns {number | null}
 */
export function resolveMetric(metric, batch = null) {
  if (metric.command) return runMetric(/** @type {{command: string}} */ (metric));
  return asInteger(batch ? batch[metric.name] : undefined);
}

/**
 * ISO 8601 week-date string (`YYYY-Www`) for a timestamp. Lifted verbatim from the
 * proven `plato/bin/stats-weekly.js` (the "Thursday of the week" rule): the week's
 * calendar year follows its Thursday, so a Dec-30 Monday lands in next-year W01.
 * @param {string} isoStr
 * @returns {string}
 */
export function isoWeek(isoStr) {
  const d = new Date(isoStr);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Parse a snapshot-history JSONL string and collapse it to one row per ISO week —
 * the *latest* snapshot in each week. Blank/unparseable lines and rows without `ts`
 * are skipped. Result is sorted oldest → newest, each row tagged with `.week`.
 *
 * Load-bearing assumption (same as plato): `ts` is ISO 8601 with a trailing `Z`, so
 * lexical string order matches chronological order — that's why latest-per-week uses
 * a plain `>` on the string.
 * @param {string} jsonl
 * @returns {Array<Record<string, any> & { week: string }>}
 */
export function loadWeeks(jsonl) {
  const byWeek = new Map();
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || !row.ts) continue;
    const week = isoWeek(row.ts);
    const prev = byWeek.get(week);
    if (!prev || row.ts > prev.ts) byWeek.set(week, { ...row, week });
  }
  return [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * Aggregate a flightlog `errors.jsonl` over a trailing window. Returns counts and
 * names only — **never messages or stacks** (those stay private on the box). The
 * `top` map is the few noisiest groups (for "which area — api or mail-auth?"); the
 * `flagged` list is every group whose count crossed `flagAtLeast`.
 * @param {string} jsonl  Raw errors.jsonl content.
 * @param {{ groupBy?: string, flagAtLeast?: number, windowDays?: number, now?: number, topN?: number }} [opts]
 * @returns {{ total_7d: number, top: Record<string, number>, flagged: string[] }}
 */
export function flightlogSummary(jsonl, opts = {}) {
  const { groupBy = 'name', flagAtLeast = 20, windowDays = 7, now = Date.now(), topN = 3 } = opts;
  const cutoff = now - windowDays * DAY;
  const counts = new Map();
  let total = 0;
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || !row.ts || new Date(row.ts).getTime() < cutoff) continue;
    total++;
    const key = row[groupBy] ?? 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = Object.fromEntries(sorted.slice(0, topN));
  const flagged = sorted.filter(([, c]) => c >= flagAtLeast).map(([k]) => k);
  return { total_7d: total, top, flagged };
}

/**
 * Week-over-week delta string: `+N` / `-N`, or `''` when zero, missing, or no prior
 * week (so a flat or baseline cell stays clean, matching the existing digests).
 * @param {number | null | undefined} curr
 * @param {number | null | undefined} prev
 * @returns {string}
 */
export function fmtDelta(curr, prev) {
  if (prev == null || curr == null) return '';
  const d = curr - prev;
  return d === 0 ? '' : d > 0 ? `+${d}` : `${d}`;
}

const padL = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);

/**
 * Render the digest email body: a fixed-width WoW table over the declared metric
 * columns (generic — whatever names you pass), newest week first, plus one optional
 * flightlog line. Pure — no I/O. `digest.js` hands this to `email.js`.
 * @param {{ app: string, weeks: Array<Record<string, any> & { week: string }>,
 *   metricNames: string[], show?: number,
 *   flightlog?: { total_7d: number, top: Record<string, number>, flagged: string[] } | null }} args
 * @returns {string}
 */
export function renderDigest({ app, weeks, metricNames, show = 4, flightlog = null }) {
  const last = weeks.slice(-show).reverse(); // newest first
  const span = weeks.length === 0 ? '(no snapshots)'
    : weeks.length === 1 ? weeks[0].week
    : `${weeks[0].week} → ${weeks[weeks.length - 1].week}`;

  const header = `${padR('week', 8)} | ` + metricNames.map((m) => `${padL(m, 7)} ${padL('Δ', 4)}`).join(' | ');
  const rule = '-'.repeat(header.length);
  const rows = last.map((w, i) => {
    const prev = last[i + 1]; // next-older row
    return `${padR(w.week, 8)} | ` +
      metricNames.map((m) => `${padL(w[m] ?? '·', 7)} ${padL(fmtDelta(w[m], prev?.[m]), 4)}`).join(' | ');
  });

  const lines = [
    `${app} weekly stats — ${span}`,
    `weeks in log: ${weeks.length}`,
    '',
    header,
    rule,
    ...rows,
  ];
  if (flightlog) {
    const top = Object.entries(flightlog.top).map(([k, c]) => `${k}×${c}`).join(', ') || 'none';
    lines.push(
      '',
      `flightlog (last 7d): ${flightlog.total_7d} errors. top: ${top}.   ` +
        `≥flag: ${flightlog.flagged.length ? flightlog.flagged.join(', ') : 'none'}`,
    );
  }
  lines.push('', 'Δ is week-over-week vs the next-older row; blank when 0 or no prior week.');
  return lines.join('\n') + '\n';
}
