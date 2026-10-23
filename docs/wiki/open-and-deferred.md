---
title: Open and deferred
slug: open-and-deferred
summary: Dropped, deferred and open items from the PRD, including the 0.4.x hardening entries.
sources:
  - docs/archive/2026-05-31-prd.md
---

# Open and deferred

Source: PRD section 12, "Open / deferred" (docs/archive/2026-05-31-prd.md:396-443).

## Dropped

- `http` JSON-body assertion is dropped, not deferred; `http` is status-only (docs/archive/2026-05-31-prd.md:398-398).

## Open (needs confirmation)

- flightlog `groupBy` defaults to the error `name` (class). If an app's "api vs mail-auth" split lives in a flightlog `context` field (e.g. `where`), set `groupBy` to that key (docs/archive/2026-05-31-prd.md:399-402).
- It is still to be CONFIRMED which field carries the area in the apps' `errors.jsonl`. It stays configurable, with no parsing logic (docs/archive/2026-05-31-prd.md:401-402).

## Deferred

- HTTP/JSON metric source: a metric is a `command` returning an integer, which covers all current SQLite apps. Add an HTTP source only if a number lives behind an endpoint (docs/archive/2026-05-31-prd.md:403-404).
- Daily collector plus separate weekly digest (two timers): 0.1.0 does one weekly run for leanness. Split only if an adopter needs intra-week granularity (docs/archive/2026-05-31-prd.md:405-406).
- Richer trend math (slopes, anomalies) is out; it is a dashboard's job (docs/archive/2026-05-31-prd.md:407-407).
- Backup engines beyond sqlite/postgres/mysql (Mongo, Redis and so on): use the `command` opt-out and a dump cookbook in `pulselog.context.md`. They are deferred as built-ins because Mongo SSPL and Redis RSAL are not OSS; Valkey is TBD (docs/archive/2026-05-31-prd.md:423-424).

## Ratified backup decisions

- Backup mode targets 0.2.0, RATIFIED. This is moot now that 0.1.0 has shipped, so backup lands in 0.2.0 as planned (docs/archive/2026-05-31-prd.md:408-409).
- Backup failure exit code is `1` (loud), per D15, RATIFIED 2026-05-31 (docs/archive/2026-05-31-prd.md:410-410).
- Backup `$PULSELOG_STAGE` handoff (a staging dir, tar what lands) rather than tarring a fixed path, RATIFIED 2026-05-31 (docs/archive/2026-05-31-prd.md:411-412).
- Backup `db` safe-default engines are sqlite, postgres and mysql/MariaDB (D16). `include` is a static copy with per-path `optional` (D17). RATIFIED 2026-05-31 (docs/archive/2026-05-31-prd.md:413-414).

## Out of pulselog: off-host copy, encryption, restore-test

- These are explicitly out; they are the operator's `rsync`, keys and policy. pulselog owns only the local envelope (section 4, D14) (docs/archive/2026-05-31-prd.md:415-416).
- Recommended shape (0.3.1 docs, not a feature): the off-host step is a pull, not a push. The backed-up box holds no credential to the off-host copy, so a compromised box cannot delete a backup it cannot write (docs/archive/2026-05-31-prd.md:417-419).
- It uses a read-only forced-command SSH key (`examples/pull-restricted.sh`), watched off-host with a `file-age` dead-man's-switch (docs/archive/2026-05-31-prd.md:419-420).
- A post-publish push hook was considered and declined: push is weaker for the compromise case, and the `&&`-chain plus pull already cover it. Revisit only if many ask (docs/archive/2026-05-31-prd.md:421-422).

## 0.4.0 and 0.4.x hardening entries

### Per-check `timeoutMs` and in-run retry (0.4.0, first-adopter feedback)

- `service` and `disk` un-hardcode their 5 s timeout (defaults unchanged) and label a killed probe as `timeout` (docs/archive/2026-05-31-prd.md:425-427).
- Optional `retries`/`retryDelayMs`, per-check or via a global `retry` default, re-probe a failing check within one run so a transient blip on a shared host does not page (docs/archive/2026-05-31-prd.md:427-428).
- Division of labour: mechanism (probe accuracy and timeout) is pulselog's; policy (how many failures make a page) stays the adopter's (docs/archive/2026-05-31-prd.md:428-429).
- A cross-run consecutive-failure debounce was declined. It needs persistent health state and is alert dedup (a stated refusal); threshold-paging belongs to the JSONL-consuming layer (docs/archive/2026-05-31-prd.md:430-431).

### Security pass (0.4.0, audit and repro-validated)

- The CLI refuses a group/world-writable or non-owner config, since it executes commands as us, often root (docs/archive/2026-05-31-prd.md:432-433).
- Backup tightens its umask and enforces `dir` 0700 even when pre-existing, leaving no temp-archive perms window (docs/archive/2026-05-31-prd.md:433-434).
- The DB password reaches only the engine's own env var (docs/archive/2026-05-31-prd.md:434-434).
- A `name` or `db[].name` containing `/`, `\` or `..` is rejected, so it cannot escape the stage (docs/archive/2026-05-31-prd.md:434-436).
- Config remains the documented trust boundary; these are defense-in-depth, each reproduced (docs/archive/2026-05-31-prd.md:435-436).

### Config-gate refinement (0.4.1, first-adopter feedback)

- The 0.4.0 ownership rule was stricter than the `ssh`/`sudo` precedent it cited. It refused a root-owned config read by a non-root service user, though that file is not writable by the reader and so is not attacker-controlled (docs/archive/2026-05-31-prd.md:437-440).
- The gate now allows an owner of the running user or root, still refusing group/world-writable. This matches `ssh` exactly and lets a root-owned deploy tree serve service units, the shape the first adopter (gitdone) hit on upgrade (docs/archive/2026-05-31-prd.md:440-442).
- One line; no default change (docs/archive/2026-05-31-prd.md:442-442).
