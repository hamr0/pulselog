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

/**
 * @param {{ configPath: string }} args
 * @returns {Promise<{ total: number, failures: number }>}
 */
export async function run({ configPath }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const enabled = (config.checks || []).filter((c) => c.enabled !== false);
  const host = hostname();

  const results = await Promise.all(
    enabled.map(async (cfg) => {
      const fn = CHECKS[cfg.type];
      if (!fn) return { cfg, ok: false, reason: `unknown check type "${cfg.type}"` };
      try {
        return { cfg, ...(await fn(cfg)) };
      } catch (err) {
        return { cfg, ok: false, reason: `check error: ${err.message}` };
      }
    }),
  );

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
