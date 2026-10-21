#!/usr/bin/env bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends jackd2 libjack-jackd2-dev pkg-config binutils >/dev/null
gcc -O2 /tests/jack-signal.c -o /tmp/ffb-jack-signal $(pkg-config --cflags --libs jack) -lm
export JACK_DEFAULT_SERVER=ffb
jackd --no-realtime --port-max 32 --name ffb -d dummy -r 48000 -p 256 >/tmp/jack-server.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
node /tests/jack-runtime.mjs
