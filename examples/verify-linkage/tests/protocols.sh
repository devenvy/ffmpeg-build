#!/usr/bin/env bash
set -euo pipefail
FFB_CRYPTO_TEST_TMP=$(mktemp -d)
export FFB_CRYPTO_TEST_TMP
trap 'rm -rf "$FFB_CRYPTO_TEST_TMP"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$FFB_CRYPTO_TEST_TMP/key.pem" -out "$FFB_CRYPTO_TEST_TMP/cert.pem" -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$FFB_CRYPTO_TEST_TMP/wrong-key.pem" -out "$FFB_CRYPTO_TEST_TMP/wrong-cert.pem" -days 1 -subj /CN=wrong 2>/dev/null
node "$(dirname "$0")/protocols.mjs"
