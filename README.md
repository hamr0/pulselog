```
   http · tcp · ssl · disk    ─┐
   file-age · service · cmd    ─┤   ╭───────────────╮      {"ts":…,"kind":"health",…}
   weekly metrics  (--digest)  ─┼─▶ │ ▓▓ pulselog ▓▓ │ ─▶  {"ts":…,"kind":"stats",…}
   db + files      (--backup)  ─┘   ╰───────────────╯      {"ts":…,"kind":"backup",…}
                                  probes from outside        silent on green · email on signal
                                  · readable anytime

   pulselog
```

> A scheduled **external** watcher for the apps you run. Probes APIs, databases, backups, SSL certs, disks, and services — stays silent when green, emails you when something breaks — rolls up the **numbers that matter** into a weekly week-over-week digest, and takes safe, rotated **backups** (curated DB dumps + your certs/configs). Every result is **one JSON line** in the same core dialect [flightlog](https://github.com/hamr0/flightlog) uses for errors, so one `tail` / `jq` / uploader spans errors, health, stats, and backups.
> **Zero** production dependencies (`node:*` + global `fetch`), Node >= 18. No daemon, no SaaS, no telemetry — run it from cron or a systemd timer. The JSONL *is* the interface.

<p align="center">
  <a href="https://github.com/hamr0/pulselog/actions/workflows/ci.yml"><img src="https://github.com/hamr0/pulselog/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/pulselog?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

---

## What this is

pulselog is the outside sibling to flightlog. flightlog records **what broke** *inside* your app (in-process); pulselog probes **whether it's up** from outside, summarizes the foundational numbers weekly, and keeps safe rotated backups. The triad: **health** (is it up) · **stats** (how's it trending) · **backup** (is it safe). Three modes, **one config**, one JSONL dialect — composed at read time, never one shared file.

- **health** (default) — run enabled checks concurrently, **stay silent on green**, write one `kind:"health"` line per failure, send **one** summary email when anything fails.
- **digest** (`--digest`) — one weekly run: collect adopter-declared **metrics** (each a command that prints one integer), append **one `kind:"stats"` line per week** to a history file, and email a week-over-week table. Optional flightlog 7-day error rollup — **counts and names only, never messages or stacks**.
- **backup** (`--backup`) — stage **curated DB dumps** (sqlite/postgres/mysql, each with the consistency-safe defaults) plus **static `include`s** (certs, configs, keys), tar atomically, enforce a size floor, and roll retention. One `kind:"backup"` line per run; a failed backup **exits `1` (loud)** and never rotates a good archive away.

Same ethos as flightlog — embed it, don't run it; zero deps; no daemon, no SaaS, no telemetry. It is **not** a metrics database, dashboard, or uptime SaaS, **not** a general logger, **not** a backup *engine* (it wraps your dump, doesn't replace it), and ships **no UI or server** — the JSONL is the whole read surface. The only per-app customization is *which* checks, *which* metrics, and *what* to back up; pulselog owns the shape (probe → emit → alert).

## Install

```sh
npm install pulselog
# or run without installing:
npx pulselog --config ./health.config.json
```

Node **>= 18**. **Zero production dependencies** (vanilla + `node:*` + global `fetch`).

## Quick start

Write a config (copy `config.example.json`), then run each mode on its own schedule.

```cron
# health — every 5 minutes (silent on green → no cron mail)
*/5 * * * *  cd /opt/myapp && npx pulselog --config ./health.config.json

# digest — once a week (Mon 08:00): snapshot metrics → week-over-week email
0 8 * * 1    cd /opt/myapp && npx pulselog --digest --config ./pulselog.config.json

# backup — nightly (02:00): dump DBs + tar certs/configs → rotated archive
0 2 * * *    cd /opt/myapp && npx pulselog --backup --config ./backup.config.json
```

**Health checks** — turn on only what you need (`enabled: false` switches one off):

| type | passes when | key fields (defaults) |
|---|---|---|
| `http` | endpoint returns the expected status | `url`, `expectStatus` (200), `timeoutMs` (5000) |
| `tcp` | host:port accepts a connection (DB/queue reachability) | `host`, `port`, `timeoutMs` (5000) |
| `ssl` | TLS cert is not near expiry | `host`, `port` (443), `warnDays` (14) |
| `disk` | path is below a usage threshold | `path`, `maxPercent` (85), `timeoutMs` (5000) |
| `file-age` | newest file in a dir is fresh (backups ran) | `path`, `maxAgeHours`, `pattern`, `recursive` |
| `service` | a systemd unit is `active` | `unit`, `timeoutMs` (5000) |
| `command` | any command exits `0` — the escape hatch | `command`, `args`, `timeoutMs` (10000) |

App-specific probes (mail-queue depth, `pg_isready`, a bespoke script) go through `command` — run **without a shell** (`command` + `args` array); for a pipe, use `"command": "sh", "args": ["-c", "…"]`.

`file-age` scans one directory by default; set `"recursive": true` for date-stamped backup layouts (`daily/<date>/app.db`) so it finds the newest match anywhere below `path`.

Every check takes a `timeoutMs`, and a noisy host won't page on a single blip: set `retries` (default 0) + `retryDelayMs` (default 1000) per check, or a top-level `retry` block as the default each check can override — a check that recovers on a retry stays green; one that fails every attempt is recorded once. (Retry is per-run only; "page after N consecutive runs" is alert policy for your JSONL consumer, not pulselog.)

**Digest metrics** — each is a name and a command that prints **one integer**; that integer is *all* pulselog stores. Anything else records `null` for that metric (noted, never fatal):

```jsonc
"digest": {
  "app": "myapp",
  "history": "/var/lib/myapp/stats.jsonl",      // its OWN file; one line appended per week
  "email": "ops@example.com",                    // omit → the history line is the artifact
  "metrics": [                                    // ← the ONLY per-app customization
    { "name": "users", "command": "sqlite3", "args": ["/var/lib/myapp/app.db", "select count(distinct customer) from pins"] },
    { "name": "pins",  "command": "sqlite3", "args": ["/var/lib/myapp/app.db", "select count(*) from pins"] }
  ]
}
```

`--dry-run` renders the table to stdout without writing or emailing. Got one command that computes many numbers in a single pass? Declare `metricsCommand` (a command that prints a flat JSON object of named integers) and let each metric pick its value by name — one spawn, not one per metric. See `config.example.json` and the [integration guide](pulselog.context.md) for every option (`metricsCommand`, `skipIfFlat`, flightlog enrichment, `weeks`).

**Backup** — stage three kinds of source into a fresh `$PULSELOG_STAGE`, then tar atomically, floor, and rotate. At least one source is required:

```jsonc
"backup": {
  "app": "myapp",
  "dir":  "/var/lib/myapp/backups",     // archives live here (own dir) → <name>-<UTC stamp>.tar.gz
  "name": "myapp-backup",
  "db": [                                // (A) curated SAFE-DEFAULT dumps — pulselog owns the consistency flags
    { "engine": "sqlite",   "path": "/var/lib/myapp/app.db" },              // → node:sqlite VACUUM INTO (Node >= 22.5)
    { "engine": "postgres", "url": "postgres://u@/app", "passwordEnv": "PGPASSWORD" }, // → pg_dump -Fc
    { "engine": "mysql",    "url": "mysql://u@/app",    "passwordEnv": "MYSQL_PWD" }    // → mysqldump --single-transaction
  ],
  "include": [                           // (B) static files copied in (symlinks preserved)
    "/etc/letsencrypt",                  //     required: missing → fail loud
    { "path": "/etc/myapp/extra", "optional": true }   //     optional: missing → skip + record
  ],
  "command": "node", "args": ["dump.mjs"],   // (C) opt-out: your own dump writes into $PULSELOG_STAGE
  "keepLast": 7, "keepDays": 30,         // retention (≥1 required): keep newest-N and/or newer-than-D
  "minBytes": 1024,                      // integrity floor — a smaller archive fails the run
  "history": "/var/lib/myapp/backup.jsonl",
  "email": "ops@example.com"             // alert on failure; omit → the history line is the record
}
```

pulselog owns the **envelope** (stage → tar → atomic `mv` → size floor → rolling retention over its own `<name>-*` archives → `kind:"backup"` line). It is **not a backup engine**: `db` ships the consistency-safe defaults for the common OSS engines, `include` is a plain file copy, and anything else (Mongo, Redis, a replica) stays your `command`. Off-host copy, encryption, and restore-testing are the operator's job. A failed run **records, alerts, and exits `1`** — and never rotates, so a bad backup can't delete a good one. The archive holds DB dumps + keys, so it's written **`0600`** (dir `0700`), and DB passwords pass via env, never the command line. See the [integration guide](pulselog.context.md) for the dump cookbook and every option.

## The record

Same core fields as flightlog (`ts`, `kind`, …) so one set of tools reads all the streams. Each writer keeps its **own** file — two processes must never append one file (rotation races, perms):

```json
{"ts":"2026-05-31T12:00:00.000Z","kind":"health","name":"backup","message":"stale: newest 31.2h old (max 26h)","check_type":"file-age","status":"fail"}
{"ts":"2026-05-31T08:00:00.000Z","kind":"stats","app":"myapp","users":128,"pins":3140}
{"ts":"2026-05-31T02:00:05.000Z","kind":"backup","app":"myapp","name":"myapp-backup","status":"ok","bytes":48213050,"files":5,"kept":7,"skipped":[]}
```

Compose at read time — one timeline across errors, health, stats, and backups:

```sh
jq -s 'sort_by(.ts)' errors.jsonl health.jsonl stats.jsonl backup.jsonl
```

JSONL files are created `0600` (owner-only) so data isn't world-readable on a shared host. **Exit codes:** `0` when a run completed (failures are emailed + logged — the alert is the signal, so cron stays quiet); `1` only when the run itself couldn't proceed (missing/invalid config), so a misconfiguration surfaces loudly.

50 tests pass on CI (Node 22) — health checks (live local HTTP server, tmp files), digest (metric parse, batch `metricsCommand`, ISO-week WoW, the flightlog 7-day rollup, render, and a **mutation-tested privacy invariant**: an error's message/stack must never reach the history line or the email), and backup (staging, atomic publish, retention, and the security regressions). Ships TypeScript types generated from JSDoc — `import { run, runDigest } from "pulselog"` gives autocomplete out of the box.

## Docs

| | |
|---|---|
| **[Integration Guide](pulselog.context.md)** | The complete adopter contract — both modes, every option, the record shapes, the privacy spine, the refusals. Hand it to your AI assistant. |
| **[PRD](docs/01-product/2026-05-31-prd.md)** | Locked decisions + *why*, success criteria, the refusals, build order. *(repo-only)* |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## flightlog + pulselog — a lightweight server-log suite

Two halves of one observability story for apps you run yourself: a **zero-dep,
self-hosted alternative to Sentry and hosted analytics/uptime monitoring**. Same
JSONL dialect, so one `tail` / `jq` / uploader spans both. Embed [flightlog](https://github.com/hamr0/flightlog)
*inside* the app; schedule pulselog *outside* it.

| | [flightlog](https://github.com/hamr0/flightlog) | [pulselog](https://github.com/hamr0/pulselog) |
|---|---|---|
| **Vantage** | inside the app (in-process) | outside, scheduled watcher |
| **Answers** | what broke | is it up · how it's trending · is it safe |
| **Captures** | uncaught errors, rejections, `capture()` | health · weekly stats · rotated backups |
| **Runs** | embedded, fires on every error | cron — health 5m · digest weekly · backup nightly |
| **Output** | one JSONL line per error | one JSONL line per result (same dialect) |
| **Replaces** | Sentry, Rollbar, Bugsnag | hosted analytics, Pingdom, UptimeRobot |

## License

Apache 2.0. See [LICENSE](LICENSE).
