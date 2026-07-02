# pulselog — adopter contract

A scheduled **external** watcher for the apps you run — the outside sibling to
[flightlog](https://github.com/hamr0/flightlog) (which records errors from *inside*
your app). You point a cron job or systemd timer at it. It has three modes — the triad
**health** (is it up) · **stats** (how's it trending) · **backup** (is it safe):

- **health** — "is it up right now?" Probe HTTP/TCP/TLS/disk/backups/systemd on a
  schedule; **stay silent when green**; email **one** summary when something breaks.
- **digest** — "how is it trending?" Once a week, collect a few **foundational
  numbers you declare**, append one snapshot line to a history log, and email a
  week-over-week table — optionally with a flightlog error summary.
- **backup** — "is it safe?" Stage **curated DB dumps** (sqlite/postgres/mysql) plus
  static **includes** (certs, configs, keys) into one archive, tar atomically,
  enforce a size floor, and roll retention. A failed run **exits `1` (loud)**.

Every signal is **one JSON line** in flightlog's core dialect (`ts`, `kind`, …), so
`tail`/`jq`/an uploader work across all your streams. Zero production dependencies
(`node:*` + global `fetch`). No daemon, no SaaS, no telemetry.

This file is the complete contract: every option, all three modes, what pulselog
deliberately does **not** do, the privacy model, and the gotchas.

> **Status:** `0.7.0` is published — all three modes (health + digest + **`backup`**)
> are on npm. `0.4.0` added a per-check `timeoutMs` and opt-in in-run `retries`, and a
> security pass (config-perms gate, backup dir/umask tightening, per-engine password env,
> name-escape guards). `0.4.1` refines the config-ownership gate to allow a **root-owned**
> config (not just self-owned), matching `ssh`. `0.6.0` aligns the `command` check's
> timeout reason with the others (`timeout after Ns`, not the misleading `exit 1
> (timeout)`). `0.7.0` adds an opt-in **`alert.fallback`** sink (a second, out-of-band
> delivery path so a dead MTA can't silence the tool). Defaults are unchanged.

## What pulselog is and is NOT

- It is a **lightweight wrapper** of what your server/OS already offers (`curl`,
  `systemctl`, `df`, a SQL `count`), generalized into config-driven mechanism.
- It is **not** a daemon/scheduler (you bring cron/systemd), **not** a log
  aggregator/shipper/SIEM, **not** a metrics database/dashboard, **not** an uptime
  SaaS, **not** an alerting platform (one email, no paging/routing), **not** a backup
  *engine* (it wraps your dump + tars/rotates; off-host copy, encryption, and
  restore-testing stay the operator's job), and **not** a transport (it never
  uploads — shipping the JSONL is a separate layer you build).
- **Mechanism is in pulselog; policy and data are yours.** You choose which checks
  run and which numbers to watch; pulselog never invents either, and never stores
  anything you didn't ask it to.

## Which mode do I need?

| You want… | Mode | Cadence |
|---|---|---|
| To be emailed when the app/DB/cert/backup breaks | `health` | often (e.g. every 5 min) |
| A weekly "is it growing?" stats email + error summary | `digest` | weekly |
| Safe, rotated archives of your DBs + certs/configs | `backup` | nightly |

All read **one** config file (`pulselog.config.json` — one source of truth) with
separate sections (`checks` / `digest` / `backup`); the mode flag picks which runs.

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
| `disk` | path is below a usage threshold | `path`, `maxPercent` (85), `timeoutMs` (5000) |
| `file-age` | newest file in a dir is fresh (backups ran) | `path`, `maxAgeHours`, `pattern`, `recursive` (false — set true for date-stamped `daily/<date>/` layouts) |
| `service` | a systemd unit is `active` | `unit`, `timeoutMs` (5000) |
| `command` | any command exits `0` — the escape hatch | `command`, `args`, `timeoutMs` (10000) |

> `http` checks the **status code only** — by design. App-specific body assertions
> (e.g. a `/health` JSON field) go through `command` (`curl … | jq -e …`). pulselog
> core never grows body parsing.

> `service` tests `systemctl is-active` — correct for a **long-running unit** or an
> **armed timer** (active while waiting). It is **wrong for a `oneshot` `.service`**: a
> healthy oneshot finishes `inactive (dead)`, so `service` would report it DOWN. For
> "did the last oneshot/timer run **succeed**?", use `command`. `systemctl is-failed`
> exits **0 when the unit *is* failed**, so invert it through a shell (the `command`
> check is healthy on exit 0):
> `{ "type": "command", "command": "sh", "args": ["-c", "! systemctl is-failed --quiet my.service"] }`
> — healthy whenever the unit is **not** failed, which includes a clean
> dead-after-success. Add `systemctl show -p Result,ActiveExitTimestamp` if you also
> want last-run recency. pulselog core stays `is-active`; oneshot semantics live in
> your `command`.

### Retry — don't page on a transient blip

A single timed-out probe on a loaded or shared host shouldn't alert. Set `retries`
(default `0`) and `retryDelayMs` (default `1000`) to re-probe a **failing** check in the
same run before it's recorded — per-check, or globally via a top-level `retry` block
that each check can override:

```jsonc
{
  "retry": { "retries": 2, "retryDelayMs": 2000 },   // default for every check
  "checks": [
    { "type": "http", "name": "api", "url": "…" },                         // inherits 2×/2s
    { "type": "service", "name": "worker", "unit": "worker.service",
      "retries": 0 },                                                       // opt OUT for this one
    { "type": "tcp", "name": "db", "host": "…", "port": 5432,
      "retries": 4, "retryDelayMs": 500 }                                   // tune per service
  ]
}
```

- A check that **recovers** on a retry is treated as green (no line, no email). One that
  fails **every** attempt is recorded **once** (never one line per attempt), its reason
  noting `(after N attempts)`.
- **Stateless on purpose.** Retry decides whether a probe is *really* failing **within
  one run** — it never remembers failures across runs. "Page only after N consecutive
  *runs* fail" is alert **policy** and stays in the layer that consumes the JSONL (see
  the refusals); pulselog keeps no cross-run health state.
- Pair with per-check `timeoutMs` (now on every check incl. `service`/`disk`): loosen the
  timeout where a probe is legitimately slow, retry where it's flaky — different knobs.

On a failure it appends one JSONL line **per failing check** and sends **one**
summary email. Silent on success.

> **`alert.logTail` carries payloads — by design.** When set, the alert email includes
> the **last 20 raw lines** of that file verbatim (messages, stacks, whatever it holds).
> That's the opposite stance from the digest's flightlog rollup (counts + names only):
> an *actionable* alert wants the detail, but it means the alert email may contain
> PII/secrets. Point it at a file you're willing to email, and send to a trusted
> recipient. Omit it and the alert stays summary-only.

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
| `metrics[]` | — | `{ name, command?, args?, timeoutMs? }`. A metric with its own `command` prints **one integer**; anything else records `null` for that metric (noted, never fatal). Run **without a shell** (`command` + `args` array, like the health `command` check) — for a pipe/shell metric, use `"command": "sh", "args": ["-c", "… | …"]`. A metric with **no** `command` is filled by name from `metricsCommand` (below). |
| `metricsCommand` | — | Optional. `{ command, args?, timeoutMs? }` — one command that prints a **flat JSON object of named integers** in a single pass; each `metrics[]` entry without its own `command` takes its value by `name` from that object. See "Batch metrics" below. |
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

### Batch metrics (one command, many numbers)

By default each metric is its own `command` → one integer. If a single pass already
computes *several* numbers (e.g. one scan over an event log yields `events`,
`completed`, `pending`, `orgs`…), declare `metricsCommand` and let each metric pick its
value by name instead of paying one spawn per metric:

```jsonc
"digest": {
  "app": "gitdone",
  "history": "/var/lib/gitdone/stats.jsonl",
  "metricsCommand": { "command": "node", "args": ["bin/stats.js", "--metrics-json"] },
  //                  // stdout: {"events":42,"completed":18,"pending":3,"orgs":7}
  "metrics": [
    { "name": "events" }, { "name": "completed" }, { "name": "pending" }, { "name": "orgs" }
  ]
}
```

- The command must print a **flat JSON object** (`{"name": <integer>, …}`) on stdout.
  An array, a scalar, non-JSON, a non-zero exit, or a timeout records `null` for every
  batch-sourced metric — same "never sinks the run" guard as a single metric.
- **You still declare every name.** Only names in `metrics[]` reach the snapshot — a
  key the batch emits but you didn't declare is ignored; a name you declared but the
  batch omits (or whose value isn't a whole number — a float, bool, or string) records
  `null`. The "store only what you read" contract is unchanged; this only amortizes an
  expensive computation.
- **Mix freely.** A `metrics[]` entry *with* its own `command` runs that command (and
  overrides any same-named batch key), so you can pair one batch pass with a couple of
  standalone metrics.

### Cadence vs the table (run daily if you want)

The table groups history **by ISO week — the latest snapshot in each week wins** — so
cadence and the table are decoupled. Run `--digest` **daily** and you get finer
history (every line is kept; `history` is never rotated) *and* free proof-of-life,
while the WoW table still collapses to one row per week. The week's row simply reflects
its most recent run. (If you run daily for proof-of-life, leave `skipIfFlat` **off** —
otherwise an unchanged day sends no email, though the history line is still written.)

---

## Backup mode

> Shipped in `0.2.0`. `pulselog --backup --config ./backup.config.json`.

One scheduled run stages your state into a fresh, private staging dir
(`$PULSELOG_STAGE`), tars it to one archive, **publishes atomically**, enforces a
size floor, and rolls retention. pulselog owns the **envelope**; you declare the
**sources**. At least one source (`db` / `include` / `command`) is required.

```jsonc
"backup": {
  "app":  "myapp",
  "dir":  "/var/lib/myapp/backups",        // archives live here, its OWN dir → <name>-<UTC stamp>.tar.gz
  "name": "myapp-backup",                   // archive prefix (also the retention key)

  "db": [                                   // (A) curated safe-default dumps — see the table below
    { "engine": "sqlite",   "path": "/var/lib/myapp/app.db", "name": "app" },
    { "engine": "sqlite",   "path": "/var/lib/myapp/cache.db", "optional": true }, // absent file → skip+record
    { "engine": "postgres", "url": "postgres://u@/app", "passwordEnv": "PGPASSWORD" },
    { "engine": "mysql",    "url": "mysql://u@host:3306/app", "passwordEnv": "MYSQL_PWD" }
  ],
  "include": [                              // (B) static copy into the stage (symlinks preserved)
    "/etc/letsencrypt",                     //     string = REQUIRED (missing → fail loud, exit 1)
    { "path": "/etc/myapp/optional.d", "optional": true }   // {path,optional} = skip + record if missing
  ],
  "command": "node", "args": ["dump.mjs"],  // (C) opt-out: your own dump writes into $PULSELOG_STAGE
  "timeoutMs": 600000,                       //     optional cap on the command

  "keepLast": 7,                            // retention: keep newest N …
  "keepDays": 30,                           //   … and/or newer-than-D days (≥1 required; union — never deletes what a rule keeps)
  "minBytes": 1024,                         // integrity floor — a smaller archive fails the run (no publish, no rotation)
  "history": "/var/lib/myapp/backup.jsonl", // one kind:"backup" line per run, its OWN file (0600)
  "email": "ops@example.com", "from": "alerts@myapp.com"   // alert on FAILURE only; omit → the line is the record
}
```

**Built-in `db` engines** — the safe default *encodes the consistency opinion* (the
value over a hand-rolled command). The tool must be on `PATH` (else the run fails
loud) except `sqlite`, which is in-process:

| `engine` | pulselog runs | Output in stage | Connection |
|---|---|---|---|
| `sqlite` | `node:sqlite` `VACUUM INTO` (online, checkpoints WAL; **needs Node ≥ 22.5**) | `<label>.db` | `path` |
| `postgres` | `pg_dump -Fc` (custom format: compressed, selective restore) | `<label>.dump` | `url` (+ `passwordEnv`) |
| `mysql` | `mysqldump --single-transaction --quick --routines --triggers --result-file` (MySQL **and** MariaDB; streamed to disk, not buffered in memory) | `<label>.sql` | `url` (+ `passwordEnv`) |

`label` is the entry's `name`, else `<engine>-<index>`. **Passwords go via env, never
argv:** set `passwordEnv` (the name of an env var holding the password) and/or embed it
in the `url` — either way pulselog routes it through `PGPASSWORD`/`MYSQL_PWD` to the
child and strips it from the URL, so it never appears in `pg_dump`'s command line (where
any local user could read it from the process table).

**Dump cookbook (the `command` opt-out)** — for engines pulselog doesn't bundle, your
`command` writes whatever it needs into `$PULSELOG_STAGE` and exits non-zero on
failure:

```jsonc
// MongoDB:        "command": "sh", "args": ["-c", "mongodump --archive=\"$PULSELOG_STAGE/mongo.archive\" --gzip"]
// Redis/Valkey:   "command": "sh", "args": ["-c", "redis-cli --rdb \"$PULSELOG_STAGE/dump.rdb\""]
// Postgres roles: "command": "sh", "args": ["-c", "pg_dumpall --globals-only > \"$PULSELOG_STAGE/globals.sql\""]
```

A `command` is a **first-class sole source** — the "≥1 source" rule is satisfied by
`command` alone (no `db`/`include` needed), e.g. an ssh+tar pull on a backup host.
Three things to nail down for that setup:
- **Write by `$PULSELOG_STAGE` (absolute), not by cwd.** pulselog exports
  `$PULSELOG_STAGE` (the fresh `0700` staging dir) to the child but does **not** `cd`
  into it — the command inherits pulselog's working directory (whatever cron/systemd
  set). Always target `"$PULSELOG_STAGE/…"` explicitly; don't assume cwd is the stage.
- **Non-zero exit aborts the whole run.** A failing `command` throws before `tar`, so
  there is **no publish and no rotation**, a `status:"fail"` line is written, an alert
  is attempted, and the CLI exits **1**. A prior good archive is never touched.
- **`timeoutMs`** (optional) caps the command; on timeout it's treated as a failure.

Two sources that would stage under the same filename (e.g. two different dirs both named
`config`) **fail loud** rather than one silently overwriting the other — give one a
distinct `name`/path.

**Lifecycle, in order:** stage `db` dumps → copy `include`s → run `command` → `tar` →
**`chmod 0600`** → size floor → atomic `mv` → retention (only `<name>-*.tar.gz` in `dir`,
**never** on a failed run) → one `kind:"backup"` line. The archive is created **owner-only
(`0600`)** and `dir`/staging are `0700` — it holds DB dumps and private keys, so it's
never group/world-readable. **Honesty boundary:** pulselog asserts the dump
ran and the archive is ≥ `minBytes` — **not** restorability. Off-host copy, encryption,
and restore-testing are yours (a `command` exiting 0 on a truncated dump is why the
size floor + recorded `bytes` exist). A health `file-age` check on `dir` (with
`recursive` for date-stamped layouts) is the belt-and-suspenders "did backups stop?"
net.

## The shared JSONL dialect

`kind` tells the streams apart: `uncaught`/`manual` (flightlog), `health` (pulselog
health), `stats` (pulselog digest), `backup` (pulselog backup). Each writer owns its
**own** file — two processes must not append one file (rotation races, perms). Compose
at read time:

```sh
jq -s 'sort_by(.ts)' errors.jsonl health.jsonl stats.jsonl backup.jsonl   # one timeline across all
```

## Email transport

pulselog sends via the system `mail`, else `sendmail` — zero-dependency, no SMTP
client, no credentials in pulselog. If your box has neither, add a lightweight
sendmail shim such as **msmtp** (`msmtp` + an `msmtprc`) — your choice of transport.
With no mailer present, pulselog warns once to stderr and the JSONL line remains the
record.

> **Deliverability is your MTA's job, not pulselog's.** pulselog's own alert/digest
> mail is **plain `sendmail`, unsigned** — it adds no DKIM signature or SPF alignment
> of its own. Whether an alert lands in the inbox or the spam folder rides entirely on
> the transport you put behind `mail`/`sendmail`. For reputation-sensitive alerts,
> point the shim at a relay that **signs (DKIM) and has clean IP reputation**, and keep
> a secondary signal so a spam-foldered — or wholly bounced — alert isn't your only
> notice. The concrete answer is the **`alert.fallback`** sink below (an out-of-band push
> that doesn't ride the mail path at all); the JSONL line and an off-box `file-age`
> dead-man's-switch remain complementary passive signals.

### Fallback alert sink — a second path so a dead MTA can't silence you

The failure mode the note above warns about is **circular**: if the mail path breaks, the
one alert that would tell you rides the same broken path and bounces too (the 2026-07
addypin incident — a CDN-proxied `mail.` record broke SPF/rDNS and every message bounced
at Gmail for a month, health alerts included). Add a `fallback` to any alert-bearing block
(`alert`, `digest`, `backup`) — a **command** pulselog spawns (no shell, like every other
`command`) that receives the rendered body on **stdin** and the subject as
**`PULSELOG_SUBJECT`**. Wire ntfy, a Slack/Discord webhook, `logger`, or an SMS CLI via
`curl` — no new dependency.

```jsonc
"alert": {
  "email": "ops@example.com",     // omit → the fallback is the SOLE sink (a box with no MTA)
  "fallback": {
    "when": "always",             // default. The only mode that also survives an async bounce
                                  //   AFTER a clean handoff (sendmail exit 0 = queued, not delivered).
                                  //   Or "on-primary-failure" — fire only when the local handoff fails.
    "command": "curl",
    "args": ["-m", "10", "-fsS", "-d", "@-", "https://ntfy.sh/my-secret-topic"],
    "timeoutMs": 10000            // killed past this; a kill counts as a failed fallback
  }
}
```

- **When it fires:** `always` (default) fires every alert regardless; `on-primary-failure`
  fires only when the local `mail`/`sendmail` handoff exits non-zero / is missing. With no
  `email`, the fallback is the sole sink and always fires.
- **Best-effort, never fatal:** a broken sink (non-zero, missing binary, timeout) is
  **recorded, not raised** — it never throws and never changes the exit code. The delivery
  outcome is durable: health writes a `kind:"alert"` line (`emailed`/`fallback` outcomes);
  backup folds a `fallback` field into its fail record.
- **Privacy holds:** the digest fallback carries the same already-redacted render (counts +
  group names only), never raw messages/stacks.
- **Loud on misconfig:** a `fallback` with no `command` (or a bad `when`/`args`) fails the
  run with exit 1, like any other bad config — it won't sit silently useless.
- **Secrets:** an ntfy topic / webhook token lives in `args`, so it's a secret in the
  config — the ownership gate + `0600`-ish config perms cover it; don't world-read the file.
  pulselog never logs the command or args (only `transport`/`ok`/`err`), so the token stays
  out of the JSONL.
- **True bounce detection stays off-box:** because `sendmail` exit 0 only means *queued*,
  `on-primary-failure` can't catch an async bounce — watch your own deliverability from a
  second host (a `command` check that greps the sending box's `maillog` over SSH; it must
  live off the sending host — an unprivileged service user can't read `maillog`, and its
  own alert would ride the same broken path).

> **Header fields are flattened to one line.** `to`/`from`/`subject` come from config,
> so a newline in any of them could otherwise inject extra mail headers (e.g. a smuggled
> `Bcc:`). pulselog strips `\r`/`\n` from those three fields before handing them to
> `mail`/`sendmail`; the body keeps its newlines. Nothing to configure — just know the
> values are sanitized.

### Recipe: msmtp → Gmail (simple, OSS, signed)

A good zero-fuss transport on a box with no MTA. msmtp is OSS, and routing through
Gmail means Gmail **DKIM-signs** the mail with clean IP reputation — so it satisfies
the deliverability note above rather than working around it. Install `msmtp` **and
`msmtp-mta`** (the latter provides the `/usr/sbin/sendmail` symlink pulselog's fallback
calls), then `~/.msmtprc` (`chmod 0600` — it holds a credential):

```ini
defaults
tls on
tls_starttls on
logfile ~/.msmtp.log

account gmail
host smtp.gmail.com
port 587
auth on
user you@gmail.com
from you@gmail.com
passwordeval "cat ~/.msmtp-gmail-apppass"   # app password in a 0600 file (or a keyring lookup) — not plaintext here
account default : gmail
```

…and set pulselog's `from` to the **same** address (`"from": "you@gmail.com"`).

- **App password, not your account password** — Gmail needs 2FA + a generated app
  password for SMTP.
- **`from` must equal the authenticated Gmail address** (or a verified "Send mail as"
  alias), or Gmail rewrites `From:` and alignment breaks — so keep msmtprc `from` and
  pulselog's config `from` identical.
- **Ordering:** pulselog tries `mail` before `sendmail`. On a minimal box (msmtp +
  `msmtp-mta`, no `bsd-mailx`) the `sendmail` path fires cleanly. If `mail` is also
  installed and you want it to use msmtp too, set `sendmail=/usr/bin/msmtp` in its rc.
- Gmail SMTP caps ~500 msgs/day — irrelevant for alerts, but it's not a bulk relay.

> **On a host with no MTA, a failed backup is exactly: history line written → exit 1
> → no email** (just the one-line stderr warning) — `sendEmail` never throws, and the
> failure still rethrows so the CLI exits 1. So size your **dead-man's-switch** on the
> archive, not the email. The blessed pattern is a health `file-age` check (on a
> reachable host) pointed at the backup `dir` with `maxAgeHours` **> the backup
> interval**: a failed run publishes no new archive, so freshness lapses and *that*
> watcher alerts. (Same pattern replaces a success-ping/heartbeat without pulselog ever
> phoning home.) Or just gate on the exit code in your scheduler.

## Exit codes

- **0** — the run completed (any health failures were emailed + logged; the digest
  ran; the backup succeeded). Keeps cron quiet on a normal health failure; the alert
  is the signal.
- **1** — the run itself couldn't proceed (missing/invalid config) **— or a backup
  failed.** Backup diverges on purpose (D15): producing the archive *is* the job, so
  failing to produce it is a loud failure (like a bad config), never a quiet one.
  Surfaces via cron/systemd so a missing backup isn't silent.

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
- **Backup archives are `0600`** and their `dir`/staging dirs `0700` — the archive
  holds DB dumps and private keys (TLS/DKIM). DB passwords are passed to dump tools via
  env, never argv. Off-host copy and **encryption at rest** are still yours (pulselog
  owns the local envelope only).
- **The config is a trust boundary:** `command`/`args` (health checks, digest metrics,
  the backup `command`) execute as the pulselog user — often **root** for backups that
  read `/etc/letsencrypt` or `/etc/opendkim`. Keep the config and any scripts it
  references owned by that user and not writable by others (else it's code execution).
  The CLI enforces a floor: it refuses a config that is **group/world-writable** or owned
  by **someone other than the running user or root** (the same rule `ssh` applies to its
  keys). A root-owned, non-world-writable config is fine for a non-root service unit to
  read — common when a root-owned deploy tree serves a service account.

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
- **The `sqlite` *backup* engine needs Node ≥ 22.5 (backup).** It uses the bundled
  `node:sqlite` `VACUUM INTO`; on older Node it fails loud. The package floor is Node
  ≥ 18 for health/digest — only the sqlite backup path needs 22.5. Upgrade Node, or
  dump SQLite through a `command`.
- **Each `db` source needs its connection field (backup).** `sqlite` needs `path`;
  `postgres`/`mysql` need `url`. A `db` entry missing that field — or naming an engine
  outside the built-in trio (`sqlite`/`postgres`/`mysql`) — fails loud with the field
  named, rather than producing a half-empty archive. Everything else goes through
  `command`.
- **Retention requires `keepLast` and/or `keepDays` (backup).** With neither set the
  run refuses to start, so a backup `dir` can never accumulate unbounded silently. A
  too-small archive (`minBytes`) fails the run — it is neither published nor rotated,
  so a truncated dump can't evict a good prior archive.
- **`minBytes` floors the *whole archive*, not each source (backup).** It catches a
  truncated/empty tar, but a large source can mask an empty critical one (a fat
  `certs/` payload hides an empty `repos.tar.gz`). For a per-source invariant, **assert
  it inside your `command`** (`exit 1` if the crown-jewel file is missing/empty) — that
  fails loud → no publish, no rotation, exit 1. `minBytes` stays a coarse truncation
  floor by design; pulselog doesn't grow per-source size rules.
- **`include`/`command` copies are not point-in-time snapshots (backup).** `include`
  is a plain recursive copy (symlinks preserved); a dir written *during* the copy
  (e.g. a live-written git repo) can land mid-write — the same consistency risk as any
  `tar`-over-a-live-tree, no worse. For a consistent capture, quiesce the writer or
  dump through a `command` that snapshots first. (The curated `db` engines *do* take a
  consistent dump — that's their whole value.)
- **Pull the off-host copy; lock the pull key (backup).** pulselog produces the archive
  on the box — getting it off-host (the copy that survives the box being *lost*) is
  yours, and it should be a **pull, not a push**. If the box held a credential to write
  the off-host copy, a compromised box could delete that copy too; a box that holds
  *no* off-host key can't reach a backup it can't write. Restrict the remote puller's
  SSH key to **read-only, one command** (`command="…",restrict` forced command) so a
  compromised puller gets a single archive stream, never a shell — see
  [`examples/pull-restricted.sh`](examples/pull-restricted.sh) (it streams the newest
  `<name>-*.tar.gz`; pulselog makes no `latest` symlink). Pair it with a `file-age`
  check on the pull target as the "did the backup/pull stop?" dead-man's-switch.

## What pulselog will not do (the refusals *are* the product)

- **No daemon / scheduler** — bring cron or a systemd timer.
- **No log aggregation / shipping / SIEM** — it reports numbers and error names,
  never log lines.
- **No metrics DB / dashboard / charts / UI** — it appends JSONL and renders text.
- **No alerting platform** — one email per run; no routing, escalation, paging, or
  dedup beyond "send once" / "skip if flat". In-run `retries` cushion a transient blip,
  but **cross-run failure-count debounce** ("page only after N consecutive runs fail")
  is deliberately **out**: it needs persistent health state pulselog doesn't keep, and
  it's alert dedup — that threshold lives in the layer consuming the JSONL (an
  Alertmanager-style rule, a systemd `OnFailure=`, your own reader).
- **No transport / upload** — never phones home.
- **No HTTP body assertion** — `http` is status-code only; use `command` for the rest.
- **Not flightlog** — it observes from outside; flightlog captures from inside.
  Separate tools, separate files, one dialect.
