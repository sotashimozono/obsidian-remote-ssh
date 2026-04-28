# Turn-key deploy: docker compose

A single-container sshd endpoint your obsidian-remote-ssh plugin can
connect to without you having to install / configure openssh-server
on the host directly. Drop the compose file on any docker-capable
machine (VPS, homelab box, NAS), supply your SSH public key + a
folder for the vault, and the plugin connects within minutes.

## What it gives you

- An sshd container exposing port `2222` on the host.
- A single non-privileged `obsidian` user (uid 1000) whose home
  contains the vault directory the plugin reads / writes.
- Pubkey-only authentication; password login disabled.
- Persistent host keys (no TOFU storm when you recreate the
  container).
- A vault directory bind-mounted from the host so your data lives
  outside the container's lifetime.

The plugin **auto-deploys** its `obsidian-remote-server` daemon
binary into the user's home (`~/.obsidian-remote/`) on first connect;
nothing on the host needs Go installed.

## Quick start

```bash
# 1. Clone or copy this directory to your server
cd /opt/obsidian-remote     # or wherever
# Copy the deploy/docker/ files here. Or git clone the whole repo
# and `cd obsidian-remote-ssh/deploy/docker`.

# 2. Drop your public key. The corresponding private key lives on
#    the device where Obsidian runs.
cp ~/.ssh/id_ed25519.pub ./authorized_keys

# 3. Make the dirs the compose file mounts
mkdir -p ./vault ./hostkeys

# 4. Bring it up
docker compose up -d --build
docker compose logs -f          # check sshd started cleanly

# 5. Test from the device that has the matching private key
ssh -p 2222 -i ~/.ssh/id_ed25519 obsidian@<docker-host>
# … should drop you straight into a shell as `obsidian`. exit.

# 6. In Obsidian → Remote SSH plugin → Add profile:
#      host:        <docker-host>
#      port:        2222
#      user:        obsidian
#      private key: ~/.ssh/id_ed25519     (on the device, not the server)
#      remote path: /home/obsidian/vault
#      transport:   RPC   (recommended; SFTP also works)
#    Connect. The plugin uploads the daemon on first use.
```

## Customising

Defaults match the common case. To override, copy `.env.example` to
`.env` in this directory and edit:

| Var | Default | What it controls |
|---|---|---|
| `HOST_PORT` | `2222` | Host-side port forwarded to the container's sshd. |
| `VAULT_PATH` | `./vault` | Folder on the host that becomes the vault root inside. |
| `AUTHORIZED_KEYS_PATH` | `./authorized_keys` | File on the host whose contents become the `obsidian` user's `authorized_keys`. |
| `HOSTKEYS_PATH` | `./hostkeys` | Folder where sshd persists its host keys across container recreates. |

## Operational notes

### Multiple authorized keys

`authorized_keys` is a plain file with one key per line — exactly
the OpenSSH format. Add a key per device that connects:

```bash
cat laptop.id_ed25519.pub phone.id_ed25519.pub > ./authorized_keys
docker compose restart       # only needed if sshd was running
```

The bind mount picks up changes live; the restart just makes sshd
reload the file.

### Backing up the vault

`./vault` on the host IS your vault. Standard backup tools work:

```bash
# Local snapshot
tar -czf vault-$(date +%Y%m%d).tgz vault/

# Or push to S3, restic, borg, ...
restic -r s3:s3.amazonaws.com/myvault-backup backup ./vault
```

### Rotating the SSH host keys

Delete `./hostkeys/*` and recreate the container; new keys are
generated on entrypoint. Every device will TOFU-prompt on the next
connect — accept once and the new fingerprints get cached.

### Firewall

The compose file binds `0.0.0.0:HOST_PORT`. On a public VPS
restrict the port at your firewall (ufw / iptables / cloud security
group) to the IPs that need access. Public sshd is *targeted*; key
auth helps but isn't a firewall.

## What this doesn't (yet) do

- **Multi-device shared daemon (Scenario B)**: the plugin
  auto-deploys its daemon binary on each connect, which kills any
  prior session's daemon. Two devices editing the same vault at
  once still work for read; concurrent writes collide on the
  redeploy. Per-device shadow vaults with the existing single-daemon-
  per-vault pattern is the recommended model until the planned
  E4-a.B work lands.
- **One-line installer (`curl ... | bash`)**: planned as E4-a.C.
- **HTTPS / TLS termination**: the plugin speaks SSH; there's no
  HTTP surface here. If you reverse-proxy port 2222 through nginx
  or Caddy you're on your own.
- **Automatic vault snapshots**: see "Backing up the vault" — wire
  whatever cron you already trust.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Permission denied (publickey)` | `authorized_keys` content doesn't match the private key the plugin sends, or file mode is wrong (must be readable by uid 1000). `docker exec obsidian-remote-sshd cat /home/obsidian/.ssh/authorized_keys` to verify. |
| `Host key verification failed` | The container was recreated and `./hostkeys/` was empty. Either restore from backup or accept the new fingerprint in the plugin. |
| `Connection refused` on port 2222 | Container isn't running (`docker compose ps`), or your firewall is blocking. |
| sshd refuses to start, mentions StrictModes | `authorized_keys` file mode is too open. The bind-mount picks up the host's mode; `chmod 600 authorized_keys` on the host side. |
