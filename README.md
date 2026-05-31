```
   http · tcp · ssl · disk    ─┐
   file-age · service · cmd    ─┤   ╭───────────────╮     health.jsonl
                                ├─▶ │ ▓▓ pulselog ▓▓ │ ─▶  {"ts":…,"kind":"health",…}
   weekly metrics  (--digest)  ─┘   ╰───────────────╯      {"ts":…,"kind":"stats",…}
                                  probes from outside        silent on green · email on signal
                                  · readable anytime

   pulselog
```

> A scheduled **external** watcher for the apps you run. Probes APIs, databases, backups, SSL certs, disks, and services — stays silent when green, emails you when something breaks — and on a separate weekly run rolls up the **numbers that matter** into a week-over-week digest. Every result is **one JSON line** in the same core dialect [flightlog](https://github.com/hamr0/flightlog) uses for errors, so one `tail` / `jq` / uploader spans errors, health, and stats.
> **Zero** production dependencies (`node:*` + global `fetch`), Node >= 18. No daemon, no SaaS, no telemetry — run it from cron or a systemd timer. The JSONL *is* the interface.

<p align="center">
  <a href="https://github.com/hamr0/pulselog/actions/workflows/ci.yml"><img src="https://github.com/hamr0/pulselog/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/pulselog?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

---

## What this is

pulselog is the outside sibling to flightlog. flightlog records **what broke** *inside* your app (in-process); pulselog probes **whether it's up** from outside, and summarizes the foundational numbers weekly. Two modes, **one config**, one JSONL dialect — composed at read time, never one shared file.

- **health** (default) — run enabled checks concurrently, **stay silent on green**, write one `kind:"health"` line per failure, send **one** summary email when anything fails.
- **digest** (`--digest`) — one weekly run: collect adopter-declared **metrics** (each a command that prints one integer), append **one `kind:"stats"` line per week** to a history file, and email a week-over-week table. Optional flightlog 7-day error rollup — **counts and names only, never messages or stacks**.

Same ethos as flightlog — embed it, don't run it; zero deps; no daemon, no SaaS, no telemetry. It is **not** a metrics database, dashboard, or uptime SaaS, **not** a general logger, and ships **no UI or server** — the JSONL is the whole read surface. The only per-app customization is *which* checks and *which* metrics; pulselog owns the shape (probe → emit → alert).

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
```

**Health checks** — turn on only what you need (`enabled: false` switches one off):

| type | passes when | key fields (defaults) |
|---|---|---|
| `http` | endpoint returns the expected status | `url`, `expectStatus` (200), `timeoutMs` (5000) |
| `tcp` | host:port accepts a connection (DB/queue reachability) | `host`, `port`, `timeoutMs` (5000) |
| `ssl` | TLS cert is not near expiry | `host`, `port` (443), `warnDays` (14) |
| `disk` | path is below a usage threshold | `path`, `maxPercent` (85) |
| `file-age` | newest file in a dir is fresh (backups ran) | `path`, `maxAgeHours`, `pattern` |
| `service` | a systemd unit is `active` | `unit` |
| `command` | any command exits `0` — the escape hatch | `command`, `args`, `timeoutMs` (10000) |

App-specific probes (mail-queue depth, `pg_isready`, a bespoke script) go through `command` — run **without a shell** (`command` + `args` array); for a pipe, use `"command": "sh", "args": ["-c", "…"]`.

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

`--dry-run` renders the table to stdout without writing or emailing. See `config.example.json` and the [integration guide](pulselog.context.md) for every option (`skipIfFlat`, flightlog enrichment, `weeks`).

## The record

Same core fields as flightlog (`ts`, `kind`, …) so one set of tools reads all three streams. Each writer keeps its **own** file — two processes must never append one file (rotation races, perms):

```json
{"ts":"2026-05-31T12:00:00.000Z","kind":"health","name":"backup","message":"stale: newest 31.2h old (max 26h)","check_type":"file-age","status":"fail"}
{"ts":"2026-05-31T08:00:00.000Z","kind":"stats","app":"myapp","users":128,"pins":3140}
```

Compose at read time — one timeline across errors, health, and stats:

```sh
jq -s 'sort_by(.ts)' errors.jsonl health.jsonl stats.jsonl
```

JSONL files are created `0600` (owner-only) so data isn't world-readable on a shared host. **Exit codes:** `0` when a run completed (failures are emailed + logged — the alert is the signal, so cron stays quiet); `1` only when the run itself couldn't proceed (missing/invalid config), so a misconfiguration surfaces loudly.

18 tests pass on CI (Node 22) — health checks (live local HTTP server, tmp files) and digest (metric parse, ISO-week WoW, the flightlog 7-day rollup, render, and a **mutation-tested privacy invariant**: an error's message/stack must never reach the history line or the email). Ships TypeScript types generated from JSDoc — `import { run, runDigest } from "pulselog"` gives autocomplete out of the box.

## Docs

| | |
|---|---|
| **[Integration Guide](pulselog.context.md)** | The complete adopter contract — both modes, every option, the record shapes, the privacy spine, the refusals. Hand it to your AI assistant. |
| **[PRD](docs/01-product/2026-05-31-prd.md)** | Locked decisions + *why*, success criteria, the refusals, build order. *(repo-only)* |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## License

Apache 2.0. See [LICENSE](LICENSE).
