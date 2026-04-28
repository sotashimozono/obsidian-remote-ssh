#!/bin/sh
# entrypoint:
#   - generate persistent host keys on first launch (none yet present
#     in the bind-mounted /etc/ssh/keys volume),
#   - re-own the bind-mounted vault dir so the in-container `obsidian`
#     user (uid 1000) can write into it regardless of what host uid
#     created the dir,
#   - then exec the CMD (sshd by default).

set -e

KEYDIR=/etc/ssh/keys
mkdir -p "$KEYDIR"

# Each algorithm gets its own key file. Generate only the ones that
# don't already exist in the persistent volume.
for algo in rsa ecdsa ed25519; do
  key="$KEYDIR/ssh_host_${algo}_key"
  if [ ! -f "$key" ]; then
    echo "entrypoint: generating $algo host key (one-time, persisted in volume)"
    ssh-keygen -q -t "$algo" -N '' -f "$key"
  fi
done
chmod 600 "$KEYDIR"/ssh_host_*_key 2>/dev/null || true

# Re-own the bind-mounted vault. Bind mounts inherit the host uid,
# which almost certainly isn't 1000; chown lets the obsidian user
# read/write its own vault. `|| true` so a noop run (no bind mount)
# still starts up.
chown -R obsidian:obsidian /home/obsidian/vault 2>/dev/null || true

# Bind-mounted authorized_keys files arrive read-only (recommended
# in compose) so we can't chmod/chown them, but sshd is happy with
# any owner as long as StrictModes can verify the path. If the
# bind-mount is owned by a different host uid sshd will refuse it;
# tell the user how to fix in that case rather than silently
# falling back to no-auth.
if [ -f /home/obsidian/.ssh/authorized_keys ]; then
  if ! sshd -t 2>/tmp/sshd-check.err; then
    echo "entrypoint: sshd config failed pre-check:"
    cat /tmp/sshd-check.err >&2
    echo "entrypoint: hint — authorized_keys must be readable by uid 1000 (the obsidian user)" >&2
    exit 1
  fi
fi

exec "$@"
