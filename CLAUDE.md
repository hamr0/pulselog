# CLAUDE.md — agent context for pulselog

Repo-only (not shipped to npm). Adopters read `README.md` + `pulselog.context.md`;
this file is for whoever (human or agent) *builds* pulselog.

## Constant references — read these first, every time

- **[`.claude/memory/AGENT_RULES.md`](.claude/memory/AGENT_RULES.md)** — the parent
  standard. POC-first, dependency hierarchy (vanilla → stdlib → external),
  simple-over-clever, open-source-only, security invariants, Testing Trophy,
  **build incrementally in small independent modules**. **When anything conflicts,
  AGENT_RULES wins.**
- **[`.claude/memory/LIBRARY_CONVENTIONS.md`](.claude/memory/LIBRARY_CONVENTIONS.md)**
  — how a publishable JS lib is shaped here: pure ESM + JSDoc → generated `.d.ts`
  (no drift), the adopter `context.md`, the doc set, CI/publish shape.

These two are the standing rulebook for this repo. Do not restate them here — defer
to them.

## Where the rationale lives

- **[`docs/01-product/2026-05-31-prd.md`](docs/01-product/2026-05-31-prd.md)** — the
  PRD: locked decisions + *why*, success criteria, the Go/No-Go gate, §13 validation.
  The durable reasoning that doesn't belong in the adopter-facing docs lives here.

## What pulselog is

The **outside** sibling to [flightlog](https://github.com/hamr0/flightlog): flightlog
records what broke *inside* an app (in-process); pulselog probes whether it's *up*
from outside, and rolls up the numbers that matter weekly. Two modes, **one config**,
one JSONL dialect — composed at read time, each writer its own file.

## Doctrine (one line each)

- **Zero production dependencies.** `node:*` + global `fetch` only. A second prod dep
  re-opens the PRD.
- **Lean wrapper, never complicate — "the original sin."** pulselog owns the *shape*
  (probe → emit → alert; collect → snapshot → WoW → render); the adopter owns *which*
  checks and *which* metrics. Mechanism in the lib, policy in the config.
- **The JSONL is the interface.** No UI, no server, no dashboard, no metrics DB ships.
- **Silent on green.** Health writes nothing and mails nothing when all checks pass —
  the alert is the only signal. Exit `0` on a normal run (so cron stays quiet); exit
  `1` only when the run itself can't proceed (bad/missing config).
- **Privacy is the spine.** A metric stores **only the integer its command returns**
  (the `count(distinct …)` stays in the adopter's query). The flightlog digest
  enrichment surfaces **error names + counts only — never messages or stacks** (those
  stay private on the box). Files are `0600`.

## Most-litigated refusals (don't re-add without re-opening the PRD)

- **No `http` body assertion** (`expectJson`) — **dropped, not deferred.** `http` is
  status-code only; anything richer goes through the `command` escape hatch + `jq`.
- No metrics database / dashboard / charts / UI — it appends JSONL and renders text.
- No daemon / SaaS / telemetry — run it from cron or a systemd timer.
- No daily collector + separate weekly digest (two timers) — one weekly run, one
  line/week. Integers only.
- No copying flightlog error messages/stacks into the digest — counts + names only.

## The two modes (where the code lives)

- **health** (`run()` in `src/run.js`) — `CHECKS` primitives in `src/checks.js`
  (`http`/`tcp`/`ssl`/`disk`/`file-age`/`service`/`command`), shared `sink.js` +
  `email.js`. Default CLI mode.
- **digest** (`runDigest()` in `src/digest.js`) — primitives in `src/metrics.js`
  (`runMetric`/`isoWeek`/`loadWeeks`/`flightlogSummary`/`fmtDelta`/`renderDigest`),
  reuses `sink.js` + `email.js`. CLI `--digest` / `--dry-run`.

A metric is a `command` that prints one integer — run **without a shell** (same as the
health `command` check); pipes use `command:"sh", args:["-c", …]`. This is intentional,
not a bug to "fix".

## Build approach

Modular/incremental per AGENT_RULES — each module works on its own before the next.
The **privacy invariant** is mutation-tested (`test/digest.test.js`): a deliberate
message/stack leak must make it fail. Keep it that way.

## Not shipped

`CLAUDE.md`, `docs/`, `.github/`, `.claude/` are repo-only — excluded from the
`package.json` `files` allowlist. The tarball ships `src/` + `types/` + the doc set
(`README.md`, `pulselog.context.md`, `CHANGELOG.md`) + `config.example.json` + `bin/`.
