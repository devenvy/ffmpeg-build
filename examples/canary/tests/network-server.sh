#!/usr/bin/env bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server nginx libnginx-mod-rtmp stunnel4 openssl binutils >/dev/null
mkdir -p /run/sshd
useradd --create-home ffb
echo 'ffb:ffb-test-only' | chpasswd
/usr/sbin/sshd -p 2222 -o PidFile=/tmp/ffb-sshd.pid -o PasswordAuthentication=yes -o UsePAM=no
server=$(cat /tmp/ffb-sshd.pid)
trap 'kill "$server" 2>/dev/null || true' EXIT
node /tests/network-linkage.mjs
