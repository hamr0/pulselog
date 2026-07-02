#!/bin/sh
# pulselog mail-delivery check — detect a mail-delivery regression from OFF the sending box.
#
# Why off-box: pulselog's alert/digest mail leaves the box via its MTA (Postfix, …). If
# SPF / DKIM / forward-confirmed reverse DNS break (the classic trap: the `mail.<domain>` A
# record gets re-proxied through a CDN, so it stops resolving to the sending IP), the
# receiver bounces every message — and nothing on the box can warn you, for two reasons:
#   1. an on-box health check usually runs as an unprivileged service user, which cannot
#      read root-owned /var/log/maillog; and
#   2. even if it could, its own alert would ride the same broken mail path and bounce too
#      — it can't page you for the one thing it detects (the "circular alert" gap).
# So this check runs on a SECOND host with its own working mail/notify path, and reads the
# sending box's maillog over SSH. Pair it with the 0.7.0 `alert.fallback` sink: the fallback
# gives you an out-of-band push *now*; this check tells you *why* mail is bouncing.
#
# Logic: inspect the LATEST delivery attempt to the alert recipient. Green if it was
# accepted (status=sent) or there were no attempts at all; red (→ pulselog alerts) only if
# the most recent attempt bounced. Stateless — no time-window parsing, so a days-old bounce
# can't stick the check red once mail recovers, and a lone transient bounce that later
# succeeds reads green.
#
# Wire it as a pulselog `command` check on the second host's pulselog config:
#   { "type": "command", "name": "vps-mail-delivery", "command": "/usr/local/bin/mail-delivery-check.sh" }
# with VPS_HOST / MAIL_CHECK_RECIPIENT (and optionally VPS_USER / SSH_KEY / MAILLOG) set in
# that pulselog run's environment (e.g. a systemd EnvironmentFile).
set -eu

VPS_HOST="${VPS_HOST:-}"                       # the SENDING box (host or IP). REQUIRED.
VPS_USER="${VPS_USER:-root}"                   # a user that can read the maillog (root)
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"    # key with BatchMode SSH to VPS_USER@VPS_HOST
RECIPIENT="${MAIL_CHECK_RECIPIENT:-}"          # the alert address to watch. REQUIRED.
MAILLOG="${MAILLOG:-/var/log/maillog}"         # Postfix default; Debian/Ubuntu: /var/log/mail.log

# Unwired → clean no-op (green), so an un-configured check never false-pages. The check goes
# live the moment VPS_HOST + MAIL_CHECK_RECIPIENT are set — no config change needed.
[ -n "$VPS_HOST" ] && [ -n "$RECIPIENT" ] || {
  echo "mail-delivery-check: set VPS_HOST + MAIL_CHECK_RECIPIENT to enable (no-op until then)" >&2
  exit 0
}

# `|| true`: an SSH failure (box down, key trouble) leaves $last empty, which reads green —
# a down box is already the http/ssl checks' job, and this check shouldn't double-alert on
# it. A real bounce still sets status=bounced.
# NOTE: the `status=(sent|bounced)` grep is POSTFIX-specific — other MTAs (exim, sendmail)
# log delivery outcomes differently; adjust the remote grep for yours.
last=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 \
    "${VPS_USER}@${VPS_HOST}" \
    "grep -h 'to=<${RECIPIENT}>' '${MAILLOG}' 2>/dev/null | grep -oE 'status=(sent|bounced)' | tail -1" \
    2>/dev/null || true)

# Green unless the most recent attempt bounced.
[ "$last" != "status=bounced" ]
