---
title: Build, ship and validation
slug: build-ship-and-validation
summary: Build/ship plan, the Go/No-Go gate before 0.1.0, and validation provenance.
sources:
  - docs/archive/2026-05-31-prd.md
---

# Build, ship and validation

## Build / ship plan

- **Source** is pure ESM JS plus JSDoc with no build step. The modules are `checks.js` (health), `metrics.js` (metric to integer, ISO-week WoW, flightlog 7-day group/flag), `sink.js` (shared JSONL), `email.js` (shared mailer and table render), `run.js` (health orchestrator), `digest.js` (collect, persist, render, send), `backup.js` (added in 0.2.0: stage, dump, tar, atomic mv, roll retention, record), `index.js`, and `bin/pulselog.js` (CLI mode dispatch). (docs/archive/2026-05-31-prd.md:346-351)
- **Types** come from JSDoc and are generated into `.d.ts` under five anti-drift invariants. The setup is `tsconfig.json` (`checkJs` + `strictNullChecks`), `typecheck`/`build:types`/`prepublishOnly` scripts, `types/` git-ignored but shipped, and typedefs in `src/types.js`. (docs/archive/2026-05-31-prd.md:352-354)
- **package.json** has `exports` with `types`, a `files` allowlist of `src/ bin/ types/ config.example.json README.md pulselog.context.md CHANGELOG.md`, `engines >= 18`, `bin`, repo/homepage/bugs, and devDeps `typescript` + `@types/node`. (docs/archive/2026-05-31-prd.md:355-357)
- **Doc set** is `README.md`, `pulselog.context.md`, `CHANGELOG.md`, plus repo-only `CLAUDE.md` and the PRD. (docs/archive/2026-05-31-prd.md:358-361)
  - `pulselog.context.md` is the full adopter contract. It covers both modes, the one customization question ("what foundational numbers do you want weekly?"), all options, the refusals, the privacy model and the gotchas. (docs/archive/2026-05-31-prd.md:358-361)
- **Tests** follow the Testing Trophy: mostly integration, run with `node --test`. They cover the existing 7 health tests plus digest tests: metric integer-parse, ISO-week WoW from a tmp history, flightlog 7-day group/count/flag, table render, and `--dry-run`. (docs/archive/2026-05-31-prd.md:362-365)
  - The privacy invariant test asserts that only integers and error names/counts are written or emailed, with no messages or stacks anywhere. (docs/archive/2026-05-31-prd.md:362-365)
- **CI / release** uses `ci.yml` (`npm ci`, typecheck, build:types, test) and `publish.yml`. `publish.yml` is copied from `hamr0/publish.template.yml`: manual, OIDC, idempotent, and it asserts the registry end-state. (docs/archive/2026-05-31-prd.md:366-368)

## Go / No-Go gate (before 0.1.0)

Every gate item is checked off in the PRD. (docs/archive/2026-05-31-prd.md:378-394)

- **Health:** the section 13 coverage stands, 7/7 tests are green, and `tsc` is clean. (docs/archive/2026-05-31-prd.md:378-378)
- **CLI dispatch:** `--digest` and `--dry-run` are wired and verified. Exit-code discipline holds in both modes: 0 for a normal run, 1 for bad config. (docs/archive/2026-05-31-prd.md:379-380)
- **Digest:** metric-parse, ISO-week WoW and flightlog 7-day group+flag are tested. The privacy invariant is proven by test: only integers and error names/counts appear in the history line and the email. The suite is 18/18 green. The privacy test was mutation-checked, so a deliberate leak makes it fail. (docs/archive/2026-05-31-prd.md:381-384)
- **Docs:** `pulselog.context.md` documents both modes, the one customization question and the refusals. (docs/archive/2026-05-31-prd.md:385-386)
- **Packaging:** `npm pack` ships only the `files` allowlist. It was verified at 21 files, with no `docs/`, `.claude/`, `.github/`, `test/`, `CLAUDE.md` or `tsconfig` (LICENSE is auto-included). (docs/archive/2026-05-31-prd.md:387-388)
- **CI:** green on GitHub Actions and passing on `main` (run 26721187873). (docs/archive/2026-05-31-prd.md:389-390)
- **Real adopter:** addypin reproduced its health script and a weekly digest end-to-end on 2026-05-31. That run surfaced and fixed `file-age` `recursive` for date-stamped dirs. (docs/archive/2026-05-31-prd.md:391-392)
- **Shipped:** `pulselog@0.1.0` went live on npm on 2026-05-31 via `publish.yml` OIDC trusted publishing, with signed provenance and no token (`gh workflow run`). `v0.1.0` is tagged. (docs/archive/2026-05-31-prd.md:393-394)

## Provenance and validation

- **Health** generalizes three hand-written scripts (addypin, gitdone, plato). (docs/archive/2026-05-31-prd.md:446-446)
  - The check mapping is HTTP to `http`, systemd to `service`, disk to `disk`, TLS to `ssl`, reachability to `tcp`, and freshness to `file-age`. Mailq, journal-errcount, OTS-backlog, DB-size and `pg_isready` map to `command`. (docs/archive/2026-05-31-prd.md:447-450)
  - This covers all three apps, with plato's JSON-body check handled via `command`. It was built 3 or more times, so it earns its place. (docs/archive/2026-05-31-prd.md:450-451)
- **Digest** generalizes the in-production operator-stats subsystem. (docs/archive/2026-05-31-prd.md:451-451)
  - The *collector* is `<app>/bin/stats.js`, rewritten per app. The *weekly digest* is `<app>/bin/stats-weekly.js`, duplicated nearly verbatim between plato and gitdone. pulselog absorbs both behind one declared metrics list. (docs/archive/2026-05-31-prd.md:451-454)
  - The snapshot/log/ISO-week grounding comes from `plato/data/stats.log`, `plato/bin/stats-weekly.js` and `gitdone/.claude/stash/phase1-stats-subsystem.md`. That stash note supplies the principles "on-demand walks not a counter store", "one row per week" and "privacy-safe aggregates only — no PII leaves the box". (docs/archive/2026-05-31-prd.md:454-457)
- **Backup** generalizes the per-app backup jobs: `addypin/ops/homeserver/addypin-backup.sh`, `plato/bin/backup.sh` (plus `bin/db-snapshot.mjs`) and `gitdone/ops/homeserver/gitdone-backup.sh`. (docs/archive/2026-05-31-prd.md:458-459)
  - Each hand-rolls the same envelope: a timestamped `tar.gz`, an atomic write, and rolling retention. plato's `BACKUP_KEEP` retains by count and gitdone's `KEEP_DAYS` by age. The envelope surrounds an app-specific dump. (docs/archive/2026-05-31-prd.md:459-462)
  - pulselog absorbs the envelope and the dump stays the adopter's `command`. It was built 3 or more times, so it earns its place. (docs/archive/2026-05-31-prd.md:462-463)
- **Porting rule:** the three apps port to pulselog after it is complete, and pulselog never edits their repos. (docs/archive/2026-05-31-prd.md:464-465)
