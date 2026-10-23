// `pulselog --test-alert` (0.8.0) — prove BOTH alert paths work before an incident needs
// them. Sends one clearly-labelled test message through the primary email (when `email` is
// set) and the fallback (when configured), always — `when` is ignored, the point is to
// exercise the fallback, not to decide whether it should fire. Writes nothing to any JSONL.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { sendEmail } from './email.js';
import { normalizeFallback, fireFallback } from './fallback.js';

const BLOCK = { health: 'alert', digest: 'digest', backup: 'backup' };

/**
 * Test one alert-bearing block's delivery paths. Throws on a missing block or a malformed
 * fallback (the CLI exits 1). `ok` is false when any configured path failed, or when
 * neither is configured; a missing fallback is not a failure. `lines` are for stdout.
 * @param {{ configPath: string, mode?: 'health'|'digest'|'backup' }} args
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function testAlert({ configPath, mode = 'health' }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const b = config[BLOCK[mode]];
  if (!b) throw new Error(`no "${BLOCK[mode]}" block in ${configPath} to test`);
  const fb = normalizeFallback(b.fallback);
  const host = hostname();
  const subject = `[${b.app || host}] pulselog test alert (${mode}) on ${host}`;
  const body = `This is a TEST message from \`pulselog --test-alert\` (${mode}) on ${host}.\n` +
    'No check failed. A primary "ok" means the message was queued with the local MTA,\n' +
    'not that it was delivered; confirm it arrived in the inbox.\n';

  const lines = [];
  let ok = Boolean(b.email || fb); // neither configured → nothing can alert → not ok
  if (b.email) {
    const r = sendEmail({ to: b.email, from: b.from, subject, body, timeoutMs: b.mailTimeoutMs });
    if (r.ok) lines.push(`primary (${r.transport}): ok, queued, not proof of delivery`);
    else { ok = false; lines.push(`primary: fail (${r.reason || 'failed'})`); }
  } else lines.push('primary: not configured');
  if (fb) {
    const r = fireFallback(fb, { subject, body });
    if (r.ok) lines.push('fallback: ok');
    else { ok = false; lines.push(`fallback: fail (${r.reason || 'failed'})`); }
  } else lines.push('fallback: not configured');
  return { ok, lines };
}
