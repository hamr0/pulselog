// Orchestrator: load config → run enabled checks (concurrently) → emit a JSONL
// line per FAILURE (silent on green) → send ONE summary email if anything failed.
// A single broken check can't sink the run (each is guarded); the run resolves
// with a small summary. Policy (which checks, thresholds, recipient) lives in the
// config; mechanism (probe → emit → alert) lives here.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { CHECKS } from './checks.js';
import { createSink } from './sink.js';
import { assembleEmail, sendEmail } from './email.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Coerce a config knob to a non-negative integer, else a default (a stray string/
 *  negative must never warp the retry loop bounds or crash the run). */
const nonNegInt = (v, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * Run one check, re-probing a FAILURE up to `retries` times before recording it — a
 * transient blip on a loaded host shouldn't page. `retries`/`retryDelayMs` come from
 * the check, else the global `config.retry` default, else `0`/`1000`. Stateless: this
 * only decides whether a probe is *really* failing within this run; it never carries
 * failure counts across runs (that's alert policy, not pulselog's). A failure that
 * survives all attempts notes how many it took.
 * @param {Record<string, any>} cfg
 * @param {{ retries?: number, retryDelayMs?: number }} defaults
 */
async function probe(cfg, defaults) {
  const fn = CHECKS[cfg.type];
  if (!fn) return { cfg, ok: false, reason: `unknown check type "${cfg.type}"` };
  const retries = nonNegInt(cfg.retries ?? defaults.retries, 0);
  const retryDelayMs = nonNegInt(cfg.retryDelayMs ?? defaults.retryDelayMs, 1000);
  let result;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      result = { cfg, ...(await fn(cfg)) };
    } catch (err) {
      result = { cfg, ok: false, reason: `check error: ${err.message}` };
    }
    if (result.ok) return result;
    if (attempt <= retries) await sleep(retryDelayMs);
  }
  if (retries > 0) result.reason += ` (after ${retries + 1} attempts)`;
  return result;
}

/**
 * @param {{ configPath: string }} args
 * @returns {Promise<{ total: number, failures: number }>}
 */
export async function run({ configPath }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const enabled = (config.checks || []).filter((c) => c.enabled !== false);
  const host = hostname();
  const retryDefaults = config.retry || {};

  const results = await Promise.all(enabled.map((cfg) => probe(cfg, retryDefaults)));

  const failures = results.filter((r) => !r.ok);

  const sink = createSink(config.output || {});
  const ts = new Date().toISOString();
  for (const r of failures) {
    sink.emit({
      ts,
      kind: 'health',
      name: r.cfg.name,
      message: r.reason,
      check_type: r.cfg.type,
      status: 'fail',
      host,
      ...(r.detail || {}),
    });
  }
  // Silent on green by default; opt-in heartbeat proves the watcher itself ran.
  if (failures.length === 0 && config.output && config.output.heartbeat) {
    sink.emit({ ts, kind: 'health', name: '_heartbeat', message: `all ${results.length} checks ok`, status: 'ok', host });
  }

  if (failures.length && config.alert && config.alert.email) {
    const { subject, body } = assembleEmail({ failures, host, ts, alert: config.alert });
    sendEmail({ to: config.alert.email, from: config.alert.from, subject, body });
  }

  return { total: results.length, failures: failures.length };
}
