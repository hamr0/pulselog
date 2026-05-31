// Digest orchestrator — one weekly run. Load `config.digest` → run each declared
// metric (command → integer) → optional flightlog 7-day summary → append ONE
// snapshot line to the history JSONL (the record) → render the WoW table and email
// it (or print on --dry-run). Mechanism lives here; the `metrics` list (policy) is
// the adopter's. A broken metric is recorded as null and never sinks the run.
import { readFileSync } from 'node:fs';
import { createSink } from './sink.js';
import { runMetric, flightlogSummary, loadWeeks, renderDigest } from './metrics.js';
import { sendEmail } from './email.js';

/** Read a file, or '' if it's missing/unreadable (a fresh app has no history yet). */
function readOrEmpty(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/**
 * Run the weekly digest once.
 * @param {{ configPath: string, dryRun?: boolean, now?: number }} args
 * @returns {{ app: string, week: string, metrics: Record<string, number|null>,
 *   flagged: string[], delivered: 'mail'|'sendmail'|'none'|'skipped'|'dry-run' }}
 */
export function runDigest({ configPath, dryRun = false, now = Date.now() }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const d = config.digest;
  if (!d || !Array.isArray(d.metrics)) {
    throw new Error('config has no "digest.metrics" — nothing to collect');
  }
  const app = d.app || 'app';
  const ts = new Date(now).toISOString();
  const metricNames = d.metrics.map((m) => m.name);

  // 1. collect declared metrics → snapshot values (broken → null)
  /** @type {Record<string, number|null>} */
  const metrics = {};
  for (const m of d.metrics) metrics[m.name] = runMetric(m);

  // 2. optional flightlog 7-day summary — counts + names only, never log contents
  let flightlog = null;
  if (d.flightlog && d.flightlog.file) {
    flightlog = flightlogSummary(readOrEmpty(d.flightlog.file), {
      groupBy: d.flightlog.groupBy || 'name',
      flagAtLeast: d.flightlog.flagAtLeast ?? 20,
      now,
    });
  }

  // 3. the weekly snapshot line (the record): metrics + optional error summary
  /** @type {Record<string, any>} */
  const snapshot = { ts, kind: 'stats', app, ...metrics };
  if (flightlog) snapshot.errors = flightlog;

  // append one line/week to history (no rotation — it's the long-term record);
  // skip the write on --dry-run. Build the WoW view from existing history + this line.
  const history = d.history ? readOrEmpty(d.history) : '';
  if (d.history && !dryRun) {
    createSink({ file: d.history, maxBytes: 0 }).emit(snapshot);
  }
  const weeks = loadWeeks(history + JSON.stringify(snapshot) + '\n');

  // 4. skipIfFlat: a prior week exists, every metric is unchanged, nothing flagged
  const newest = weeks[weeks.length - 1];
  const prior = weeks[weeks.length - 2];
  const flat = Boolean(prior) &&
    metricNames.every((n) => newest[n] != null && prior[n] != null && newest[n] === prior[n]) &&
    (!flightlog || flightlog.flagged.length === 0);

  const body = renderDigest({ app, weeks, metricNames, show: d.weeks || 4, flightlog });
  const subject = `[${app}] weekly stats — ${newest ? newest.week : '(none)'}`;

  // 5. deliver: print on dry-run; skip a flat week if asked; else email if a
  //    recipient is set; otherwise the history line is the artifact.
  /** @type {'mail'|'sendmail'|'none'|'skipped'|'dry-run'} */
  let delivered;
  if (dryRun) {
    process.stdout.write(`Subject: ${subject}\n\n${body}\n`);
    delivered = 'dry-run';
  } else if (d.skipIfFlat && flat) {
    delivered = 'skipped';
  } else if (d.email) {
    delivered = sendEmail({ to: d.email, from: d.from, subject, body });
  } else {
    delivered = 'none';
  }

  return { app, week: newest ? newest.week : '', metrics, flagged: flightlog ? flightlog.flagged : [], delivered };
}
