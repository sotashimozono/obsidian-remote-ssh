# Minimal sshd container for plugin integration tests.
#
# Provides a `tester` user with a known UID, an empty `vault/` home
# subdir for the test to write into, and pubkey-only auth. The
# authorized_keys is bind-mounted by docker-compose so we can rotate
# the key pair without rebuilding the image. `StrictModes no` lets
# sshd accept the bind-mounted key file regardless of host UID/GID
# permissions — fine for a throwaway test container, never for prod.

FROM ubuntu:22.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /var/run/sshd \
 && useradd -m -s /bin/bash -u 1000 tester \
 && mkdir -p /home/tester/.ssh /home/tester/vault \
 && chown -R tester:tester /home/tester \
 && chmod 700 /home/tester/.ssh \
 && sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'   /etc/ssh/sshd_config \
 && echo 'StrictModes no' >> /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22

# Entrypoint normalises bind-mount ownership; the CMD is the actual
# sshd. `-D` keeps sshd in the foreground; `-e` sends logs to stderr
# so `docker logs` shows them.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
