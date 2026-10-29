#!/bin/sh
set -eu

mkdir -p /run/sshd /etc/ssh/keys
chmod 0700 /etc/ssh/keys
if [ ! -f /etc/ssh/keys/ssh_host_ed25519_key ]; then
    ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/keys/ssh_host_ed25519_key
fi

/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
