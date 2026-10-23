#!/usr/bin/env node
// CLI: run one mode against a config once and exit. Built for cron / systemd timers.
//   pulselog --config ./health.config.json            # health (default)
//   pulselog --digest --config ./pulselog.config.json # weekly digest
//   pulselog --digest --dry-run --config ./...         # render to stdout, no append/email
//
// Health mode is silent when everything's green. Both modes exit 0 on a normal run
// — the email + the JSONL line are the signal, not the exit code, so cron stays quiet
// on a health failure or a flat week. Exit 1 when the run itself couldn't proceed
// (bad/missing config, unreadable file), so a misconfiguration surfaces loudly — or
// (0.8.0) when an alert/digest send was attempted and every delivery path failed.
import { statSync } from 'node:fs';
import { run } from '../src/run.js';
import { runDigest } from '../src/digest.js';
import { runBackup } from '../src/backup.js';
import { testAlert } from '../src/testalert.js';

const argv = process.argv.slice(2);
let configPath = './health.config.json';
let digest = false;
let backup = false;
let dryRun = false;
let test = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if ((a === '--config' || a === '-c') && argv[i + 1]) configPath = argv[++i];
  else if (a === '--digest') digest = true;
  else if (a === '--backup') backup = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--test-alert') test = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'pulselog — run health checks, a weekly digest, or a backup; emit JSONL, email on signal\n\n' +
        '  pulselog --config ./health.config.json              health checks (default)\n' +
        '  pulselog --digest --config ./pulselog.config.json   weekly stats digest\n' +
        '  pulselog --digest --dry-run --config ./...          render digest, no write/email\n' +
        '  pulselog --backup --config ./backup.config.json     backup (curated dumps + includes → archive)\n' +
        '  pulselog --test-alert [--digest|--backup] --config ./...  send a test via primary + fallback; exit 1 if a path fails\n\n' +
        'Health/digest stay silent on green and exit 1 only if a send fails on every path;\n' +
        'backup is silent on success and exits 1 on failure.\n' +
        'See README and config.example.json.\n',
    );
    process.exit(0);
  }
}

// The config drives command execution as THIS user — often root for backups that read
// /etc/letsencrypt or /etc/opendkim. A config someone else can write (or owns) is then
// code execution as us, so refuse it (like ssh/sudo refuse an attacker-writable config).
// Owner may be the running user OR root: a root-owned, non-world-writable file isn't
// writable by a non-root reader, so it's not attacker-controlled — this matches ssh's
// rule (owner == user or root) and lets a root-owned deploy tree serve service users.
// Missing/unreadable → leave it to the loader below to report the canonical error.
let cfgStat = null;
try { cfgStat = statSync(configPath); } catch { /* loader will fail loud */ }
if (cfgStat) {
  if (cfgStat.mode & 0o022) {
    process.stderr.write(`pulselog: refusing ${configPath}: group/world-writable (chmod go-w it)\n`);
    process.exit(1);
  }
  if (process.getuid && cfgStat.uid !== 0 && cfgStat.uid !== process.getuid()) {
    process.stderr.write(`pulselog: refusing ${configPath}: not owned by you or root (chown it)\n`);
    process.exit(1);
  }
}

// runDigest is synchronous; run is async. Promise.resolve().then(...) normalizes both
// and funnels a thrown bad-config (sync or async) into the same .catch → exit 1.
Promise.resolve()
  .then(() => {
    if (test) {
      if (digest && backup) {
        process.stderr.write('pulselog: --test-alert takes one of --digest or --backup, not both\n');
        return 1;
      }
      if (dryRun) {
        process.stderr.write('pulselog: --test-alert always sends for real; it has no --dry-run\n');
        return 1;
      }
      // Test-alert: prove both delivery paths now; writes no JSONL. Exit 1 if any path failed.
      const { ok, lines } = testAlert({ configPath, mode: backup ? 'backup' : digest ? 'digest' : 'health' });
      process.stdout.write(lines.join('\n') + '\n');
      return ok ? 0 : 1;
    }
    if (backup) {
      // Backup OWNS its exit code (D15): a failed run throws → the .catch below
      // exits 1 (loud), unlike health/digest which exit 0 and signal via the alert.
      return runBackup({ configPath }).then(({ bytes, files, kept }) => {
        process.stderr.write(`pulselog: backup ok — ${files} files, ${bytes}B, kept ${kept}\n`);
      });
    }
    if (digest) {
      const { app, week, delivered, deliveryFailed } = runDigest({ configPath, dryRun });
      process.stderr.write(`pulselog: digest ${app} ${week} → ${delivered}\n`);
      return deliveryFailed ? 1 : 0;
    }
    return run({ configPath }).then(({ total, failures, deliveryFailed }) => {
      if (failures) process.stderr.write(`pulselog: ${failures}/${total} checks failing\n`);
      if (deliveryFailed) process.stderr.write('pulselog: alert NOT delivered on any path (see the kind:"alert" record)\n');
      return deliveryFailed ? 1 : 0;
    });
  })
  // Never fail the cron on a health failure / flat week — the alert is the signal. The one
  // exception (0.8.0): the alert itself failed on every attempted path, so exit 1 and let
  // `systemctl --failed` / an off-box watcher see it. Green runs never attempt a send.
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    // couldn't even run (missing/invalid config, unreadable file), OR a backup failed (D15): fail loud.
    process.stderr.write(`pulselog: run error: ${err.message}\n`);
    process.exit(1);
  });
