---
title: Alert delivery decisions
slug: alert-delivery-decisions
summary: Fallback alert sink decisions (0.7.0) and delivery-honesty decisions (0.8.0).
sources:
  - docs/archive/2026-05-31-prd.md
---

# Alert delivery decisions

Two PRD sections lock how pulselog delivers alerts: the fallback sink (0.7.0) and delivery honesty (0.8.0). Both came from real mail incidents.

## 0.7.0 Fallback alert sink

### Origin
- The 2026-07 addypin incident: `mail.<domain>` was CDN-proxied, which broke SPF/rDNS. Every outbound message (health alerts and the digest) bounced at Gmail for about a month (docs/archive/2026-05-31-prd.md:479-481).
- pulselog ran, detected and tried to email, but the operator got nothing. This is the "circular-alert gap": the alert saying mail is broken rides the same broken path (docs/archive/2026-05-31-prd.md:481-483).

### Shape
- An opt-in `fallback` block on each alert-bearing config (`alert`, `digest`, `backup`) gives a second, out-of-band delivery path. Mechanism is in the lib, the choice of sink is in the config (docs/archive/2026-05-31-prd.md:485-487).
- It is purely additive. Without `fallback`, behavior is byte-for-byte the same as before (docs/archive/2026-05-31-prd.md:486-487).
- Surface: `fallback: { command, args?, when?, timeoutMs? }`. The body goes to child stdin and the subject to `PULSELOG_SUBJECT` (docs/archive/2026-05-31-prd.md:513-514).
- A malformed block (no `command`) fails the run loud with exit 1. Runtime spawn failures are best-effort (docs/archive/2026-05-31-prd.md:514-515).

### Locked decisions
- **D1, command sink only.** No native webhook. The command sink reuses the existing spawn, and a webhook would duplicate what `curl` does. Deferred (docs/archive/2026-05-31-prd.md:490-492).
- **D2, default `when: "always"`.** In the incident the handoff succeeded (exit 0) and the bounce was async, so `on-primary-failure` would have stayed silent. `on-primary-failure` remains for handoff-only (docs/archive/2026-05-31-prd.md:493-495).
- **D3, covers health, digest and backup.** A silently missing backup is the worst case, so it needs the fallback most (docs/archive/2026-05-31-prd.md:496-497).
- **D4, best-effort, never fatal.** A broken sink is recorded and never throws or changes the exit code (superseded in 0.8.0 for the all-paths-failed case, see D3 below). An A/B control showed the same input crashes an unguarded process (exit 1) and is neutralized by the wrapper (exit 0) (docs/archive/2026-05-31-prd.md:498-500).
- **D5, the JSONL records each sink's outcome.** Health writes a `kind:"alert"` line, backup adds a `fallback` field on the fail record, and the digest writes `delivered:"fallback"` (docs/archive/2026-05-31-prd.md:501-502).
- **D6, privacy holds.** The fallback carries the already-redacted render (counts and names only for the digest) (docs/archive/2026-05-31-prd.md:503-504).
- **D7, `--dry-run` skips both sinks** (docs/archive/2026-05-31-prd.md:505).
- **D8, one shared `spawnDelivery` primitive** in `src/deliver.js` serves the `mail`/`sendmail` sends and the fallback. It unifies `email.js`'s `spawnSync({input})` with `backup.js`'s env and timeout. The only new code is the `when` gate and config parse. `checks.js:exec()` was rejected as the wrong primitive (`execFile`, no stdin). The extraction also gave `sendEmail` handoff reporting (`{transport, ok}`) (docs/archive/2026-05-31-prd.md:506-511).

### Refusals and limits
- No webhook in v1, no pluggable-transport framework, retry queue or multi-fallback fan-out, no native maillog/bounce check-type (it stays in `examples/`), and no cross-run dedup (docs/archive/2026-05-31-prd.md:517-519).
- `sendmail` exit 0 means queued, not delivered. This is accepted, and `when:"always"` plus the off-box recipe cover it (docs/archive/2026-05-31-prd.md:519-520).
- Companion doc: `examples/mail-delivery-check.sh`, an off-box "is my VPS still delivering?" `command` check. It is to be ported from the real addypin script (docs/archive/2026-05-31-prd.md:522-525).

### Validation
- POC-first, aimed at the riskiest assumption (a best-effort stdin sink that never throws or changes the exit code), proven with an A/B control (docs/archive/2026-05-31-prd.md:527-529).
- Built in two modules. 67/67 tests passed, plus an end-to-end CLI run with a silent-on-green negative control (docs/archive/2026-05-31-prd.md:529-531).

## 0.8.0 Delivery honesty

Decision entry dated 2026-10-23 (docs/archive/2026-05-31-prd.md:533).

### Origin
- addypin's weekly digest silently never delivered for about 3 months, and latefyi hit the same bug on the same box (docs/archive/2026-05-31-prd.md:535-536).
- Cause: the unit had `NoNewPrivileges=true`, which disables `postdrop`'s setgid bit. `sendmail` then looped on `Permission denied` writing `maildrop/` (docs/archive/2026-05-31-prd.md:536-538).
- Why it stayed hidden: the send had no timeout, so the fallback never fired. `stats.jsonl` still gained a normal-looking row, the journal rotated, and both adopters validated by running the send by hand as root, bypassing the sandbox (docs/archive/2026-05-31-prd.md:538-540).

### Locked decisions
- **D1, `mailTimeoutMs` (default 30000)** on `alert`/`digest`/`backup`. It is not `timeoutMs`, because `backup.timeoutMs` already bounds the backup command. A timeout counts as a failed primary (reason `timeout`) so `on-primary-failure` fires. Each delivery child runs in its own process group, and the group is killed (docs/archive/2026-05-31-prd.md:543-546).
  - Accepted limits: a duplicate via the fallback on a just-in-time queue (a duplicate beats silence), and an orphaned group if pulselog is signalled mid-send, which systemd's cgroup kill reaps (docs/archive/2026-05-31-prd.md:546-548).
- **D2, the digest records delivery durably.** A `kind:"delivery"` line sits beside the `stats` snapshot, and `reason` is also on the health `alert` and backup fail records. The WoW reader ignores non-`stats` rows. A `stats` row alone only proved the metrics ran (docs/archive/2026-05-31-prd.md:549-551).
- **D3, exit-code exception to D10 (user-approved).** Health and digest exit 1 when a send was attempted and every attempted delivery path failed. When the alert itself fails nothing else signals, and the incident (exit 0 for three months) is the evidence (docs/archive/2026-05-31-prd.md:552-555).
  - Green runs, flat-week skips and "nothing configured" still exit 0, so silent on green holds. D15 (backup) is unchanged (docs/archive/2026-05-31-prd.md:555-556).
  - This supersedes §15 D4 ("never changes the exit code") for this one case. A broken sink still never throws (docs/archive/2026-05-31-prd.md:556-557).
- **D4, `pulselog --test-alert`** (with `--digest`/`--backup`) sends one test message through the primary and the fallback, ignoring `when`. It reports per-path results, exits 1 on any configured failure or when nothing is configured, and writes no JSONL. Validation belongs under the real unit sandbox (docs/archive/2026-05-31-prd.md:558-560).
- **D5, honest result line**, for example `→ mail:fail(timeout), fallback:fail(exit 3)`. `mail`/`sendmail` exit 0 is documented as queued, not delivered (docs/archive/2026-05-31-prd.md:561-562).

### Refusals (unchanged)
- No in-tool bounce detection (it stays off-box), no retry queue, and no new transport (docs/archive/2026-05-31-prd.md:564-565).
