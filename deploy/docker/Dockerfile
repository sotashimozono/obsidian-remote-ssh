# Production-oriented sshd container for obsidian-remote-ssh.
#
# Deliberately minimal: openssh-server + a single non-privileged
# `obsidian` user (uid 1000) whose home holds the vault dir the
# plugin reads/writes. The plugin auto-deploys its `obsidian-remote-
# server` daemon binary into `~/.obsidian-remote/` on connect; this
# image just provides a stable, locked-down sshd endpoint to deploy
# into.
#
# Authentication: pubkey-only. The container reads the user's
# authorized_keys via bind-mount so key rotation doesn't need a
# rebuild.
#
# Host keys: the entrypoint regenerates them on first launch and
# writes them into `/etc/ssh/keys` which is intended to be
# bind-mounted by docker-compose so the keys persist across
# container restarts (otherwise users would TOFU-prompt every time
# the container is recreated).

FROM alpine:3.23

RUN apk add --no-cache openssh-server bash shadow tini iproute2 \
 && mkdir -p /var/empty /etc/ssh/keys \
 && adduser -D -u 1000 -s /bin/bash obsidian \
 && mkdir -p /home/obsidian/.ssh /home/obsidian/vault \
 && chown -R obsidian:obsidian /home/obsidian \
 && chmod 700 /home/obsidian/.ssh

# sshd config: pubkey-only, no root login, point at the persistent
# host-key dir, force a known port. StrictModes stays ON (production
# default) — users get warned about bad key permissions rather than
# silently accepting them; the test container at docker/test-sshd
# disables it but that's a developer convenience, not a prod default.
RUN sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/'      /etc/ssh/sshd_config \
 && sed -i 's/#\?PermitRootLogin.*/PermitRootLogin no/'                     /etc/ssh/sshd_config \
 && sed -i 's/#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'          /etc/ssh/sshd_config \
 && sed -i 's/#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/#\?UsePAM.*/UsePAM no/'                                       /etc/ssh/sshd_config \
 && sed -i 's|#\?HostKey /etc/ssh/ssh_host_rsa_key|HostKey /etc/ssh/keys/ssh_host_rsa_key|'         /etc/ssh/sshd_config \
 && sed -i 's|#\?HostKey /etc/ssh/ssh_host_ecdsa_key|HostKey /etc/ssh/keys/ssh_host_ecdsa_key|'     /etc/ssh/sshd_config \
 && sed -i 's|#\?HostKey /etc/ssh/ssh_host_ed25519_key|HostKey /etc/ssh/keys/ssh_host_ed25519_key|' /etc/ssh/sshd_config \
 && echo 'AllowUsers obsidian' >> /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22

# tini handles PID-1 reaping (sshd forks; without an init the
# zombies pile up over a long-running container's lifetime).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
