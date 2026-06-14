# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- **README — added a "flightlog + pulselog" pairing table** near the end, framing the two as a lightweight, self-hosted server-log suite (in-process error capture vs. external scheduled watcher) over the same JSONL dialect — the zero-dep alternative to Sentry and hosted analytics/uptime monitoring. The same table ships in both repos. README only; no package change.

## [0.4.1] - 2026-06-01

A one-line refinement to the `0.4.0` config-ownership gate so it matches the `ssh`
precedent it cites. No new feature, no default change; still zero production dependencies.

### Security
- **Config-ownership gate now allows a root-owned config, not just a self-owned one.**
  `0.4.0` refused any config the running user didn't own — which also rejected a
  root-owned, non-world-writable config read by a non-root service user, a very common
  deploy shape (a root-owned tree served to a service account). `ssh`/`sudo`, the cited
  precedent, allow an owner of **the user or root** and refuse only group/world-writable
  or third-party-owned files; `bin/pulselog.js` now does the same. A root-owned,
  non-world-writable config isn't writable by a non-root reader, so it carries no
  code-execution-as-that-user risk. The world-writable refusal and the
  service-user-owned-config-read-by-root refusal are both unchanged.

## [0.4.0] - 2026-06-01

Reliability + hardening from the first-adopter (gitdone) pass: a per-check timeout knob
and in-run retry so a transient blip on a shared host doesn't page, plus a security
audit that closed four local-attack/footgun gaps. New config is opt-in — defaults
preserve prior behavior. Still zero production dependencies.

### Security
- **CLI refuses a config others can write.** The config drives command execution as the
  running user (often root for backups), so `bin/pulselog.js` now rejects a config that
  is group/world-writable or not owned by the running user — closing a local
  code-execution-as-root path on a misconfigured deployment (precedent: `ssh`/`sudo`).
- **Backup tightens a pre-existing dir + no temp-archive perms window.** `runBackup`
  sets `umask 0077` for the run (the `tar` temp file is born `0600`, no brief `0644`
  window) and `chmod 0700`s the backup dir even when it pre-existed with looser perms
  (`mkdir`'s `mode` is ignored on an existing dir). Restores the prior umask after.
- **DB password reaches only its engine's env var.** A `postgres` dump no longer also
  carries `MYSQL_PWD` in its child env (and vice-versa) — smaller secret footprint.
- **Backup/db `name` can't escape the stage.** A `name`/`db[].name` containing `/`, `\`,
  or `..` is rejected loudly instead of writing the dump/archive outside the target dir.

### Added
- **Per-check `timeoutMs` on every check** — `service` and `disk` were hardcoded to
  5000 ms; both now read `timeoutMs` (default 5000, unchanged) like `http`/`tcp`/`ssl`/
  `command`. A killed probe is now labeled `timeout after Ns` (previously `service`
  surfaced a bare `unknown`).
- **In-run retry** — optional `retries` (default `0`) + `retryDelayMs` (default `1000`),
  per-check or via a top-level `retry` default each check can override. A failing check
  is re-probed within the same run before it's recorded; one that recovers is green, one
  that fails every attempt is recorded **once** with `(after N attempts)`. Stateless —
  no cross-run failure memory. Defaults preserve current behavior exactly (one attempt).

### Not doing
- **Cross-run consecutive-failure debounce** ("page after N runs fail") — declined: it
  requires persistent health state pulselog doesn't keep and is alert dedup, which stays
  in the JSONL-consuming layer. In-run `retries` cover the transient-blip case.

## [0.3.1] - 2026-06-01

Documentation + packaging only — no API or behavior change. Transport and off-host
guidance hardened from the first-adopter (gitdone) pass, and `examples/` now ships in
the package.

### Packaged
- **`examples/` is now in the published tarball** (`files` whitelist) — so the new
  `examples/pull-restricted.sh`, referenced from `pulselog.context.md`, resolves for
  npm readers, not just on GitHub.

### Documented
- **Email transport caveats** — pulselog's alert/digest mail is plain `sendmail`,
  **unsigned** (no DKIM/SPF of its own); deliverability rides entirely on the operator's
  MTA/relay, so reputation-sensitive alerts should sit behind a signing relay plus a
  secondary signal. Also surfaced the existing **header-field flattening** (`to`/`from`/
  `subject` have `\r`/`\n` stripped to prevent header injection from config values) in
  the contract, not just the 0.2.0 security notes. Added a concrete **msmtp → Gmail**
  transport recipe (the documented shim, now with a copy-paste `~/.msmtprc` + the
  `from`-alignment / app-password / `msmtp-mta` gotchas).
- **Off-host pull hardening** — a backup gotcha (pull, don't push; the box holds no key
  to the off-host copy it could be coerced into deleting) plus
  `examples/pull-restricted.sh`, a read-only forced-command SSH key that streams only
  the newest `<name>-*.tar.gz`.

## [0.3.0] - 2026-06-01

A batch metric source for the digest, plus documentation hardening from the first
adopter (gitdone) mapping its watchers onto pulselog. Still zero production
dependencies (`node:*` + global `fetch`); backward compatible.

### Added
- **Digest `metricsCommand`** — an optional batch metric source: one command that
  prints a **flat JSON object of named integers**, from which each `metrics[]` entry
  *without* its own `command` takes its value by `name`. Amortizes an expensive
  snapshot (e.g. ~14 numbers from one scan instead of one spawn per metric) while
  keeping every invariant: only declared names reach the snapshot, each value passes
  the same whole-number gate (float/bool/string/missing → `null`, never sinks the run),
  and a metric *with* its own `command` still runs and overrides the batch. Backward
  compatible — `command` is now optional on a metric only when `metricsCommand` is set.

### Documented
- Digest **cadence is decoupled from the table** — history groups by ISO week (latest
  snapshot per week), so `--digest` can run daily for finer history + proof-of-life
  while the WoW table stays weekly.
- `alert.logTail` **includes raw log lines** (messages/stacks) in the alert email by
  design — the opposite stance from the digest's counts-and-names-only rollup.
- `service` is `is-active` semantics (long-running/armed-timer units); **oneshot**
  success goes through `command` (`! systemctl is-failed …`).
- Backup: a `command` is a **first-class sole source**; write by absolute
  `$PULSELOG_STAGE` (cwd is not the stage); a non-zero exit aborts (no publish/rotate,
  exit 1). `minBytes` is a **whole-archive** floor — assert per-source integrity inside
  your `command`. `include` copies are **not** point-in-time snapshots. With no MTA, a
  failed backup is log-line + exit 1 + no email — size a `file-age` dead-man's-switch
  on the archive accordingly.

## [0.2.0] - 2026-05-31

A third mode — **backups** (see the PRD in `docs/01-product`). Published to npm via
GitHub Actions OIDC trusted publishing (signed provenance, no token). Still zero
production dependencies (`node:*` + global `fetch`).

### Added
- **Backup mode** (`pulselog --backup --config <file>`) — one scheduled run that
  stages sources into a fresh `$PULSELOG_STAGE`, tars them, publishes atomically
  (`.tmp`→`mv`), enforces a `minBytes` integrity floor, and rolls retention
  (`keepLast` count and/or `keepDays` age) over its **own** `<name>-*` archives only.
  Three source kinds: **`db`** — curated safe-default dumps for the common OSS engines
  (`sqlite` via bundled node:sqlite `VACUUM INTO`; `postgres` via `pg_dump -Fc`;
  `mysql`/MariaDB via `mysqldump --single-transaction`), each encoding the consistency
  opinion; **`include`** — a static file/dir copy (certs/configs/keys), symlinks
  preserved, each path required (missing → fail) or `{path,optional:true}` (skip +
  record); and **`command`** — the opt-out for anything else. Writes one
  `kind:"backup"` line; **a failed run records, alerts, and exits `1` (loud)** and
  **never rotates**, so a bad run can't delete a good prior archive. The `sqlite`
  engine needs Node ≥ 22.5 (fails loud otherwise). A `db` source that omits its
  connection field (`path` for `sqlite`, `url` for `postgres`/`mysql`) or names an
  engine outside the built-in trio **fails loud with the field named** — never a
  half-empty archive.

### Security
- Backup archives are created **`0600`** (owner-only) — they hold DB dumps and
  private keys (TLS/DKIM); the dir is created `0700`. Previously `0644`.
- The `postgres` password is **stripped from the connection URL** and routed via
  `PGPASSWORD` env, so it never appears in `pg_dump`'s argv (process-table leak).
- `mysqldump` writes via `--result-file` (streams to disk) instead of buffering the
  whole dump in memory.
- Two backup sources that would stage under the same filename now **fail loud**
  instead of one silently overwriting the other.
- Email header fields (`to`/`from`/`subject`) are flattened to one line, preventing
  header injection from a newline in config-supplied values.

## [0.1.0] - 2026-05-31

First functional release — published to npm via GitHub Actions OIDC trusted
publishing (signed provenance, no token). Zero production dependencies
(`node:*` + global `fetch`), Node ≥ 18.

### Added
- **Health mode** (`pulselog --config <file>`) — scheduled external checks of a
  running app: `http` (status code only), `tcp`, `ssl` (cert expiry), `disk`,
  `file-age` (backup freshness, with `recursive` for date-stamped `daily/<date>/`
  layouts), `service` (systemd), and `command` (the escape
  hatch). Runs enabled checks concurrently, **stays silent on green**, writes one
  `kind:"health"` JSONL line per failure, and sends **one** summary email when
  anything fails. Exit `0` on a health failure (the alert is the signal; cron stays
  quiet); exit `1` only when the run itself can't proceed (bad/missing config).
- **Digest mode** (`pulselog --digest --config <file>`) — one weekly run that
  collects adopter-declared **metrics** (each a `command` that prints one integer),
  appends **one `kind:"stats"` snapshot line per week** to a history JSONL, and
  emails a week-over-week table. The only per-app customization is the metrics list;
  ISO-week bucketing, deltas, history, and rendering are built in. Optional
  **flightlog enrichment**: a 7-day error count, the top error names with counts, and
  a configurable `≥N` flag (`flagAtLeast`, default 20) — **names and counts only,
  never messages or stacks**. `--dry-run` renders without sending or appending;
  `skipIfFlat` suppresses the email on an unchanged week with no flag.
- Records use flightlog's core JSONL dialect (`ts`, `kind`, …) so one toolset reads
  errors, health, and stats; each writer keeps its **own** file, merged at read time
  with `jq`.
- **TypeScript types generated from JSDoc** (`types/*.d.ts`, built on publish) — the
  package ships type definitions, so `import { run, runDigest } from "pulselog"` gives
  autocomplete and type-checking with no `@types` package. The programmatic surface is
  `run` (health), `runDigest` (digest), `CHECKS`, `createSink`, `assembleEmail`,
  `sendEmail`; the CLI in `bin/` is the usual entry point.

### Security
- JSONL files are created `0600` (owner read/write only) so health/stats data isn't
  group/world-readable on a shared host. Metric values are integers only; the
  flightlog summary never copies error messages or stacks into the digest or email.

## [0.0.1] - 2026-05-31

### Added
- Name-reservation placeholder published to npm. No functional API yet — the package
  throws on import, directing users to the repo. Reserves `pulselog` while `0.1.0`
  is built.

[Unreleased]: https://github.com/hamr0/pulselog/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/hamr0/pulselog/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/hamr0/pulselog/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/hamr0/pulselog/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/hamr0/pulselog/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hamr0/pulselog/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hamr0/pulselog/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/hamr0/pulselog/releases/tag/v0.0.1
