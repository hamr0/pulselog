#!/bin/sh
# pulselog-pull — forced command for a RESTRICTED, read-only off-host backup key.
#
# Why a forced command: pulselog produces the archive on the box; pulling it off-host
# is the operator's job. Do that as a PULL, not a push — a box that holds no credential
# to the off-host copy can't reach (or delete) a backup it has no key to write, so a
# compromised box can't take the off-host copy down with it. This script is the box-side
# half: it streams ONLY the newest pulselog archive to stdout and ignores whatever the
# client asked for, so the key can never be a shell, run anything else, or read outside
# the backup dir.
#
# pulselog names archives "<name>-<UTC stamp>.tar.gz" and makes NO "latest" symlink, so
# this picks the newest "<NAME>-*.tar.gz" itself — the puller doesn't need to know the
# stamp.
#
# Install on the box pulselog backs up:
#   1. cp this to /usr/local/bin/pulselog-pull ; chmod 0755 /usr/local/bin/pulselog-pull
#   2. set DIR/NAME below to your backup.dir / backup.name
#   3. add the puller's key to ~/.ssh/authorized_keys as ONE line:
#        command="/usr/local/bin/pulselog-pull",restrict ssh-ed25519 AAAA... puller@federver
#      (`restrict` removes pty/agent/port/X11 forwarding — the forced command is all
#       this key can ever do.)
#
# Pull from the off-host box (e.g. a cron on federver):
#   ssh -i ~/.ssh/pull_key backup@box > "myapp-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
#
# Belt-and-suspenders: on the off-host side, run a pulselog `file-age` health check over
# the directory you pull into — if the pull (or the upstream backup) stops, freshness
# lapses and that watcher alerts. The box itself never needs a mailer or a credential.
set -eu

DIR=/var/lib/myapp/backups   # = pulselog backup.dir
NAME=myapp-backup            # = pulselog backup.name (archive prefix)

newest=$(ls -1t "$DIR/$NAME"-*.tar.gz 2>/dev/null | head -n1)
[ -n "$newest" ] || { echo "pulselog-pull: no $NAME-*.tar.gz in $DIR" >&2; exit 1; }
exec cat -- "$newest"
