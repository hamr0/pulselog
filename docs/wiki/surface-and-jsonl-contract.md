---
title: Surface and JSONL contract
slug: surface-and-jsonl-contract
summary: The whole CLI/health/digest/backup surface, the shared JSONL dialect, and self-failure handling.
sources:
  - docs/archive/2026-05-31-prd.md
---

# Surface and JSONL contract

## CLI

Three invocations cover the surface (docs/archive/2026-05-31-prd.md:159-163):

- `pulselog --config <file>` runs health, the default; silent on green.
- `pulselog --digest --config <file>` snapshots metrics, builds the week-over-week (WoW) table and emails it.
- `pulselog --digest --dry-run --config <file>` renders to stdout without sending or appending.

## Health mode (built)

- Config is `checks: [{ type, name, enabled, ...fields }]`. Each check is `async (cfg) -> {ok, reason, detail?}` and never throws (docs/archive/2026-05-31-prd.md:167-168).
- Types: `http` (status code only), `tcp`, `ssl`, `disk`, `file-age`, `service`, `command` (docs/archive/2026-05-31-prd.md:168-169).
- Enabled checks run concurrently. Each failure writes one `{kind:"health", status:"fail", ...}` JSONL line, and there is one summary email if anything failed (docs/archive/2026-05-31-prd.md:169-171).

## Digest mode

Config lives under `digest`: `app`, `history` (pulselog writes and reads it, one line per week), `email`, `from`, `weeks` (default 4), `skipIfFlat`, `metrics`, and an optional `flightlog` block (docs/archive/2026-05-31-prd.md:176-188). `metrics` is the only per-app customization (docs/archive/2026-05-31-prd.md:183).

One weekly run (docs/archive/2026-05-31-prd.md:191-213):

1. Run each metric `command`, trim stdout and parse one integer. A non-integer or failed metric records `null` plus a note and never sinks the run (docs/archive/2026-05-31-prd.md:192-194).
2. Optional `metricsCommand` emits a flat JSON object of named integers in one pass. A metric without its own `command` takes its value by `name` from that object. A metric with a `command` still runs and overrides it. Only declared names reach the line, and each value passes the same whole-number gate (docs/archive/2026-05-31-prd.md:194-199).
3. If `flightlog.file` is set, count errors from the past 7 days, grouped by `groupBy` (default the error `name`). Keep the top few and flag groups at or above `flagAtLeast` (default 20). Names and counts only (docs/archive/2026-05-31-prd.md:200-202).
4. Append one `kind:"stats"` snapshot line (mode `0600`) to `history`, covering metrics and the error summary (docs/archive/2026-05-31-prd.md:203-207).
5. Read `history`, bucket by ISO week (Mon-Sun), keep the latest snapshot per week and take the last `weeks`. Render a fixed-width WoW table with Δ computed at render time, blank when 0 or when there is no prior row (docs/archive/2026-05-31-prd.md:209-211).
6. If `email` is set and the run is not skipped by `skipIfFlat`, email the table plus the flightlog line. Otherwise the snapshot line is the artifact (docs/archive/2026-05-31-prd.md:212-213).

The digest is generic by construction: plato declares `users, posts`, gitdone declares `events`, and pulselog never knows what they mean. The error line groups by error name, or by a `groupBy` context field, rather than giving a bare count (docs/archive/2026-05-31-prd.md:228-230).

## Backup mode (0.2.0, ratified 2026-05-31)

Config under `backup` (docs/archive/2026-05-31-prd.md:235-266):

- `dir` holds the archives; pulselog stages, tars and rotates inside it. `name` is the archive prefix, giving `<name>-<UTC stamp>.tar.gz` (docs/archive/2026-05-31-prd.md:237-238).
- Three source kinds: `db` (built-in safe dumps), `include` (static copies), and `command` (the opt-out escape hatch). At least one is required (docs/archive/2026-05-31-prd.md:268-269).
- `keepLast` and/or `keepDays` set retention, and at least one is required. `minBytes` is the integrity floor. `history` is the backup's own JSONL file (docs/archive/2026-05-31-prd.md:261-265).

Built-in `db` engines (docs/archive/2026-05-31-prd.md:275-279):

| engine | safe default | output | connection |
|---|---|---|---|
| `sqlite` | `node:sqlite` `VACUUM INTO` | `<label>.db` | `path` |
| `postgres` | `pg_dump -Fc` | `<label>.dump` | `url` (+ `passwordEnv`) |
| `mysql` | `mysqldump --single-transaction --quick --routines --triggers` | `<label>.sql` | `url` (+ `passwordEnv`) |

Except for sqlite, which runs in-process, the tool must be on `PATH` or the run fails loud (docs/archive/2026-05-31-prd.md:271-273). `label` defaults to the engine plus an index, or is set via `name` (docs/archive/2026-05-31-prd.md:281). MongoDB and Redis stay on the `command` opt-out plus the dump cookbook (docs/archive/2026-05-31-prd.md:282-283).

One scheduled run (docs/archive/2026-05-31-prd.md:285-314):

1. Create a fresh staging dir, `$PULSELOG_STAGE`, and stage sources into it in order: `db`, `include`, `command` (docs/archive/2026-05-31-prd.md:286-301).
   - `db`: the password goes via env (`PGPASSWORD`/`MYSQL_PWD`) and is stripped from any URL so it never lands in argv. Dumps stream to disk and are never buffered in memory (docs/archive/2026-05-31-prd.md:287-292).
   - A missing connection field or an unknown engine fails loud with the field or engine named. A failed required dump fails the run (exit 1). An `optional` db whose file is absent is skipped and recorded. Two sources staging under the same name fail loud (docs/archive/2026-05-31-prd.md:292-296).
   - `include`: copies with symlinks preserved. A required missing path fails loud (exit 1). An `optional` one is skipped and recorded (docs/archive/2026-05-31-prd.md:297-299).
   - `command`: runs with `$PULSELOG_STAGE` set and a timeout. A non-zero exit fails the run (docs/archive/2026-05-31-prd.md:300-301).
2. Tar to a `.tmp` file, `chmod 0600`, then atomically `mv` to the canonical name, so a partial tar never appears under it. `dir` and the staging dir are `0700` (docs/archive/2026-05-31-prd.md:302-305).
3. Integrity floor: an archive that is missing or under `minBytes` fails the run (alert, exit 1) without rotating, so a bad run never deletes a good prior backup (docs/archive/2026-05-31-prd.md:306-308).
4. Rolling retention applies only to `<dir>/<name>-*.tar.gz` (docs/archive/2026-05-31-prd.md:308-309).
5. Append one `kind:"backup"` line (mode `0600`) to `history`, recording sizes and counts only (docs/archive/2026-05-31-prd.md:310-312, 320-321).
6. Success is silent. Failure sends one email and exits 1 (docs/archive/2026-05-31-prd.md:314).

The three modes form a triad: health (is it up), stats (how is it trending), backup (is it safe). A backup's `bytes` can become a digest metric, and a health `file-age` check on `dir` catches backups silently stopping (docs/archive/2026-05-31-prd.md:323-326).

## The shared JSONL dialect

- Writers share flightlog core fields (`ts`, `kind`, ...) so one toolset reads every stream (docs/archive/2026-05-31-prd.md:330-331).
- Each writer owns its own file, never a shared one, because two processes appending plus rotation is a race the PRD forbids (docs/archive/2026-05-31-prd.md:331-333).
- `kind` values: `uncaught`/`manual` (flightlog), `health`, `alert` (health delivery outcome; docs/archive/2026-05-31-prd.md:501-502), `stats`, `delivery` (digest send outcome, 0.8.0; the week-over-week reader ignores it; docs/archive/2026-05-31-prd.md:549-551), `backup` (docs/archive/2026-05-31-prd.md:333-334).
- Compose at read time: `jq -s 'sort_by(.ts)' errors.jsonl health.jsonl stats.jsonl backup.jsonl` (docs/archive/2026-05-31-prd.md:334-335).

## Self-failure handling

- A check or metric that errors is caught and recorded (failure or `null`), so one broken probe never sinks the run (docs/archive/2026-05-31-prd.md:339-340).
- The sink swallows write failures and warns once to stderr (docs/archive/2026-05-31-prd.md:340-341).
- A digest with no readable `history` starts fresh: the first week is the baseline with no Δ. A newly added metric shows baseline until it has a prior week (docs/archive/2026-05-31-prd.md:341-342).
