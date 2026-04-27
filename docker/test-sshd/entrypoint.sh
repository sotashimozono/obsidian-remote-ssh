#!/bin/sh
# entrypoint: re-own the bind-mounted vault dir before sshd starts.
#
# `/home/tester/vault` is bind-mounted from the host. On the host
# the dir is whatever uid created it (the developer's own user, or
# the CI runner — never 1000). Inside the container it shows up
# with the host's uid, so the in-container `tester` (uid 1000) can't
# write to it. We're root here (no USER directive in the Dockerfile)
# so the chown succeeds; sshd then runs as root and drops to the
# auth'd user as usual.
#
# `|| true` so a non-mounted run (developer running the container
# without compose) still starts up, even if the chown noops.

set -e
chown -R tester:tester /home/tester/vault 2>/dev/null || true
exec "$@"
