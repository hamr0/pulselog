# pulselog — adopter contract

A scheduled **external** watcher for the apps you run — the outside sibling to
[flightlog](https://github.com/hamr0/flightlog) (which records errors from *inside*
your app). You point a cron job or systemd timer at it. It has two modes:

- **health** — "is it up right now?" Probe HTTP/TCP/TLS/disk/backups/systemd on a
  schedule; **stay silent when green**; email **one** summary when something breaks.
- **digest** — "how is it trending?" Once a week, collect a few **foundational
  numbers you declare**, append one snapshot line to a history log, and email a
  week-over-week table — optionally with a flightlog error summary.

Every signal is **one JSON line** in flightlog's core dialect (`ts`, `kind`, …), so
`tail`/`jq`/an uploader work across all your streams. Zero production dependencies
(`node:*` + global `fetch`). No daemon, no SaaS, no telemetry.

This file is the complete contract: every option, both modes, what pulselog
deliberately does **not** do, the privacy model, and the gotchas.

> **Status:** building toward `0.1.0` (see the CHANGELOG). `0.0.1` is a name
> placeholder that throws on import — don't depend on it.

## What pulselog is and is NOT

- It is a **lightweight wrapper** of what your server/OS already offers (`curl`,
  `systemctl`, `df`, a SQL `count`), generalized into config-driven mechanism.
- It is **not** a daemon/scheduler (you bring cron/systemd), **not** a log
  aggregator/shipper/SIEM, **not** a metrics database/dashboard, **not** an uptime
  SaaS, **not** an alerting platform (one email, no paging/routing), and **not** a
  transport (it never uploads — shipping the JSONL is a separate layer you build).
- **Mechanism is in pulselog; policy and data are yours.** You choose which checks
  run and which numbers to watch; pulselog never invents either, and never stores
  anything you didn't ask it to.

## Which mode do I need?

| You want… | Mode | Cadence |
|---|---|---|
| To be emailed when the app/DB/cert/backup breaks | `health` | often (e.g. every 5 min) |
| A weekly "is it growing?" stats email + error summary | `digest` | weekly |

Both read **one** config file (`pulselog.config.json` — one source of truth) with
separate sections; the mode flag picks which section runs.

```
pulselog --config ./pulselog.config.json            # health (default)
pulselog --digest --config ./pulselog.config.json   # digest
pulselog --digest --dry-run --config …              # render the digest, don't send/append
```

---

## Health mode

```jsonc
{
  "output": {
    "file": "/var/lib/myapp/health.jsonl",  // its OWN file — never flightlog's errors.jsonl
    "maxBytes": 5000000,                      // rotate to .1 at this size; 0 disables
    "heartbeat": false                        // also log one "all ok" line per run
  },
  "alert": {
    "email": "ops@myapp.com",                 // omit → log only, no email
    "from": "alerts@myapp.com",
    "app": "myapp",
    "logTail": "/var/lib/myapp/errors.jsonl"  // optional: paste recent flightlog errors into the alert
  },
  "checks": [
    { "type": "http",     "name": "api",    "enabled": true, "url": "http://127.0.0.1:3000/api/health", "expectStatus": 200 },
    { "type": "tcp",      "name": "db",      "enabled": true, "host": "127.0.0.1", "port": 5432 },
    { "type": "ssl",      "name": "cert",    "enabled": true, "host": "myapp.com", "warnDays": 14 },
    { "type": "disk",     "name": "disk",    "enabled": true, "path": "/var/lib/myapp", "maxPercent": 85 },
    { "type": "file-age", "name": "backup",  "enabled": true, "path": "/var/lib/myapp-backups", "maxAgeHours": 26, "pattern": ".sqlite", "recursive": true },
    { "type": "service",  "name": "postfix", "enabled": false, "unit": "postfix.service" },
    { "type": "command",  "name": "mailq",   "enabled": false, "command": "sh", "args": ["-c", "test $(mailq | grep -c '^[A-F0-9]') -lt 50"] }
  ]
}
```

`enabled: false` switches a check off — each app turns on only what it needs.

| Check | Passes when | Key fields (defaults) |
|---|---|---|
| `http` | endpoint returns the expected **status code** | `url`, `expectStatus` (200), `timeoutMs` (5000) |
| `tcp` | host:port accepts a connection | `host`, `port`, `timeoutMs` (5000) |
| `ssl` | TLS cert is not near expiry | `host`, `port` (443), `warnDays` (14) |
| `disk` | path is below a usage threshold | `path`, `maxPercent` (85) |
| `file-age` | newest file in a dir is fresh (backups ran) | `path`, `maxAgeHours`, `pattern`, `recursive` (false — set true for date-stamped `daily/<date>/` layouts) |
| `service` | a systemd unit is `active` | `unit` |
| `command` | any command exits `0` — the escape hatch | `command`, `args`, `timeoutMs` (10000) |

> `http` checks the **status code only** — by design. App-specific body assertions
> (e.g. a `/health` JSON field) go through `command` (`curl … | jq -e …`). pulselog
> core never grows body parsing.

On a failure it appends one JSONL line **per failing check** and sends **one**
summary email. Silent on success.

---

## Digest mode

**pulselog asks you one question: _what foundational numbers do you want to watch
weekly?_** Declare them as `metrics` — each a name and a `command` that prints one
integer. Everything else (collect → snapshot → history → week-over-week → render →
email) is built in. You never write a `stats.js` again.

```jsonc
{
  "digest": {
    "app": "addypin",
    "history": "/var/lib/addypin/stats.jsonl",  // pulselog writes + reads this (one line/week, the record)
    "email": "ops@addypin.com",                 // omit / --dry-run → print, no send
    "from": "alerts@addypin.com",
    "weeks": 4,                                   // rows in the table (default 4)
    "skipIfFlat": false,                          // true → no email when every Δ=0 and nothing flagged
    "metrics": [                                  // ← the ONLY per-app customization
      { "name": "users", "command": "sqlite3", "args": ["/var/lib/addypin/addypin.db", "select count(distinct customer) from pins"] },
      { "name": "pins",  "command": "sqlite3", "args": ["/var/lib/addypin/addypin.db", "select count(*) from pins"] }
    ],
    "flightlog": { "file": "/var/lib/addypin/errors.jsonl", "groupBy": "name", "flagAtLeast": 20 }  // optional
  }
}
```

| Option | Default | Meaning |
|---|---|---|
| `app` | `"app"` | Label in the snapshot line, email subject, and header. |
| `history` | — | The snapshot JSONL pulselog appends to (one line/week) and reads back for the table. **Its own file.** |
| `email` / `from` | — | Recipient/sender. Omit → no email; the history line is the artifact. |
| `weeks` | `4` | How many weeks the table shows. |
| `skipIfFlat` | `false` | `true` → skip the email when every metric is unchanged vs last week **and** nothing is flagged. |
| `metrics[]` | — | `{ name, command, args?, timeoutMs? }`. The command must print **one integer**; anything else records `null` for that metric (noted, never fatal). Run **without a shell** (`command` + `args` array, like the health `command` check) — for a pipe/shell metric, use `"command": "sh", "args": ["-c", "… | …"]`. |
| `flightlog` | — | Optional. `{ file, groupBy?, flagAtLeast? }` — see below. |

**The snapshot line** appended each week (the record — metrics *and* any error
summary, kept for trend):

```json
{"ts":"2026-05-31T06:00:00Z","kind":"stats","app":"addypin","users":2,"pins":5,"errors":{"total_7d":31,"top":{"ApiTimeout":24,"SmtpAuthError":7},"flagged":["ApiTimeout"]}}
```

**The email** (rendered from `history`):

```
addypin weekly stats — 2026-W19 → 2026-W22
weeks in log: 4

week     |   users    Δ |    pins    Δ
2026-W22 |       3   +1 |       7   +2
2026-W21 |       2      |       5   +1
…
flightlog (last 7d): 31 errors. top: ApiTimeout×24, SmtpAuthError×7.   ≥flag: ApiTimeout
```

### flightlog enrichment (optional)

If you point `digest.flightlog.file` at a flightlog `errors.jsonl`, the digest adds
one line: the **7-day error count**, the **top error names with counts**, and a flag
for any group whose 7-day count reached `flagAtLeast` (default 20). So you see *which*
area is noisy (e.g. `ApiTimeout` vs `SmtpAuthError`), not just *that* something broke.

- `groupBy` (default `"name"`) — the field to group by. If your apps distinguish
  areas via flightlog **context** (e.g. `capture(err, { where: 'mail-auth' })`), set
  `groupBy: "where"`.
- **Counts and names only.** pulselog never copies error **messages or stacks** into
  the digest or email — those can carry payloads/PII. flightlog stays private on the
  box; you read the detail there.

---

## The shared JSONL dialect

`kind` tells the streams apart: `uncaught`/`manual` (flightlog), `health` (pulselog
health), `stats` (pulselog digest). Each writer owns its **own** file — two processes
must not append one file (rotation races, perms). Compose at read time:

```sh
jq -s 'sort_by(.ts)' errors.jsonl health.jsonl stats.jsonl   # one timeline across all three
```

## Email transport

pulselog sends via the system `mail`, else `sendmail` — zero-dependency, no SMTP
client, no credentials in pulselog. If your box has neither, add a lightweight
sendmail shim such as **msmtp** (`msmtp` + an `msmtprc`) — your choice of transport.
With no mailer present, pulselog warns once to stderr and the JSONL line remains the
record.

## Exit codes

- **0** — the run completed (any health failures were emailed + logged; the digest
  ran). Keeps cron quiet on a normal failure; the alert is the signal.
- **1** — the run itself couldn't proceed (missing/invalid config). Surfaces loudly
  via cron/systemd so a misconfiguration isn't silent.

## Privacy & threat model

- pulselog stores **only the integer a metric command returns** — never rows, never
  identifiers. Counting "unique customers" means *your* query does `count(distinct
  …)`; pulselog records the integer and cannot leak what it never reads.
- The flightlog summary is **counts + error names only** — never messages or stacks.
- pulselog **never uploads**. It writes locally and emails a summary to the address
  *you* configure. Shipping logs off-box is a separate, consent-gated layer you build
  (flightlog's `examples/ship.js` is a reference) — never folded into pulselog.
- JSONL files are created `0600` (owner read/write only) so health/stats data isn't
  group/world-readable on a shared host. The mode applies at creation; an existing
  file keeps its perms. Keep these files off shared/world-readable paths.

"Local + private" means *it never phones home* — you still own what your queries
return and what goes in `alert.app` / context.

## Gotchas

- **Silent on green is the point (health).** No output → no cron mail. If you want
  proof it ran, set `output.heartbeat: true` (one "all ok" line per run) — but the
  digest is the better proof-of-life.
- **A metric that returns a float or non-number records `null`** (integers only).
  `select count(*)` is an integer; `avg(...)` is not — wrap it (`cast(... as int)`).
- **First week is a baseline** — no prior snapshot, so deltas are blank, not zero.
  A newly-added metric shows baseline until it has a prior week.
- **`--dry-run` does not append or send** — it only renders. A real digest run
  appends exactly one line to `history`.
- **`history` is append-only and not rotated** — it's the long-term record (~52
  lines/year). Don't point `maxBytes` rotation at it; it's tiny.

## What pulselog will not do (the refusals *are* the product)

- **No daemon / scheduler** — bring cron or a systemd timer.
- **No log aggregation / shipping / SIEM** — it reports numbers and error names,
  never log lines.
- **No metrics DB / dashboard / charts / UI** — it appends JSONL and renders text.
- **No alerting platform** — one email per run; no routing, escalation, paging, or
  dedup beyond "send once" / "skip if flat".
- **No transport / upload** — never phones home.
- **No HTTP body assertion** — `http` is status-code only; use `command` for the rest.
- **Not flightlog** — it observes from outside; flightlog captures from inside.
  Separate tools, separate files, one dialect.
