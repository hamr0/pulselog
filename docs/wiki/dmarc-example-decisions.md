---
title: DMARC example decisions
slug: dmarc-example-decisions
summary: Why DMARC aggregate-report handling ships as a bundled example (examples/dmarc.mjs), not core, and the safety decisions inside it.
sources:
  - examples/dmarc.mjs
  - test/dmarc-example.test.js
  - pulselog.context.md
---

# DMARC example decisions

`examples/dmarc.mjs` turns DMARC aggregate (`rua`) reports into JSONL and feeds a digest metric and a health check. This page records why it is an example and not core. It is a section of the one PRD (§17); there are no PRD line numbers for it, so sources are file paths.

## Origin and scope
- Requested by the gitdone adopter: DMARC `rua` reports for signedreply.com and ownsub.com, so the policy can move from `p=none` to `reject` with evidence (examples/dmarc.mjs).
- The owner decided it ships as a bundled example, not core. It has been built 0 times in the wild against the "earns its place" bar (built 2-3 times), it is a parser that grows edge cases, and digest and health already cover it through the `command` metric and check primitives (pulselog.context.md).
- Promotion to core happens only if a second adopter needs it. Until then it carries no semver guarantee; adopters copy it to pin it.

## Shape
- One zero-dependency file (`node:*` only) with three subcommands: `ingest`, `metric`, `check` (examples/dmarc.mjs).
- Policy (domains, expected sending IPs, thresholds, window) lives as args in the adopter's config. The file owns only the DMARC-specific parsing: mechanism in the example, policy in the config.
- No pulselog core change: metrics are `command`s that print one integer, and the check is a health `command` check.

## Safety decisions
- Anyone can mail the public `rua` address, so decompressed reports over 20 MB and messages over 25 MB go to `bad/` (examples/dmarc.mjs).
- Decompression is capped at 20 MB in TOTAL per message, across all candidate parts, so a message full of bomb parts costs at most one 20 MB inflate.
- Once that budget is spent, only parts that need inflating are refused: a plain-XML part or a stored zip later in the same message still ingests. When no part yields a report, the recorded `dmarc-error` reason is always the first candidate's own error, however the budget ran out.
- `check` prints problems on stderr, which is what a pulselog `command` check puts in its alert.
- `ingest` refuses a `dmarc.jsonl` inside a plain `<dir>`, since it would be ingested as mail.
- Malformed input is never fatal: it is moved to `bad/` with a `dmarc-error` line, and `ingest` still exits `0`. Only bad arguments, an unreadable path, or a processed message `ingest` cannot move to `done/` or `bad/` exit `1`.
- Re-delivered reports (same org and `report_id`) are skipped.

## Validation
- Proven on 2 real Google reports, plus synthetic fixtures for multipart and gzip messages (test/dmarc-example.test.js).
- Real Microsoft and mail.ru samples are pending until local delivery is live.
