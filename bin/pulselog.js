#!/usr/bin/env node
// CLI: run one mode against a config once and exit. Built for cron / systemd timers.
//   pulselog --config ./health.config.json            # health (default)
//   pulselog --digest --config ./pulselog.config.json # weekly digest
//   pulselog --digest --dry-run --config ./...         # render to stdout, no append/email
//
// Health mode is silent when everything's green. Both modes exit 0 on a normal run
// — the email + the JSONL line are the signal, not the exit code, so cron stays quiet
// on a health failure or a flat week. Exit 1 only when the run itself couldn't proceed
// (bad/missing config, unreadable file), so a misconfiguration surfaces loudly.
import { run } from '../src/run.js';
import { runDigest } from '../src/digest.js';

const argv = process.argv.slice(2);
let configPath = './health.config.json';
let digest = false;
let dryRun = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if ((a === '--config' || a === '-c') && argv[i + 1]) configPath = argv[++i];
  else if (a === '--digest') digest = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'pulselog — run health checks or a weekly digest, emit JSONL, email on signal\n\n' +
        '  pulselog --config ./health.config.json              health checks (default)\n' +
        '  pulselog --digest --config ./pulselog.config.json   weekly stats digest\n' +
        '  pulselog --digest --dry-run --config ./...          render digest, no write/email\n\n' +
        'Health mode is silent when all checks pass. See README and config.example.json.\n',
    );
    process.exit(0);
  }
}

// runDigest is synchronous; run is async. Promise.resolve().then(...) normalizes both
// and funnels a thrown bad-config (sync or async) into the same .catch → exit 1.
Promise.resolve()
  .then(() => {
    if (digest) {
      const { app, week, delivered } = runDigest({ configPath, dryRun });
      process.stderr.write(`pulselog: digest ${app} ${week} → ${delivered}\n`);
    } else {
      return run({ configPath }).then(({ total, failures }) => {
        if (failures) process.stderr.write(`pulselog: ${failures}/${total} checks failing\n`);
      });
    }
  })
  .then(() => process.exit(0)) // never fail the cron on a health failure / flat week — the alert is the signal
  .catch((err) => {
    // couldn't even run (missing/invalid config, unreadable file): fail loud.
    process.stderr.write(`pulselog: run error: ${err.message}\n`);
    process.exit(1);
  });
