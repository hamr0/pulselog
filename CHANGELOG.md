# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Work toward the first functional release, **`0.1.0`** (see the PRD in
`docs/01-product`). Not yet published. Zero production dependencies
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

[Unreleased]: https://github.com/hamr0/pulselog/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/hamr0/pulselog/releases/tag/v0.0.1
