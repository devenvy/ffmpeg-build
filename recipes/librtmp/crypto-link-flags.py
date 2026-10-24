"""Preserve OpenSSL's native dependency closure for librtmp's shared link."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

command = shlex.split(os.environ.get('PKG_CONFIG', 'pkg-config'))
flags = subprocess.check_output(command + ['--static', '--libs', 'openssl'], text=True).strip()
if not flags or '\n' in flags or '\r' in flags or '\0' in flags:
    raise SystemExit('Expected one non-empty OpenSSL pkg-config link line')
# libatomic is a compiler implementation dependency, independent of selected crypto-library owners.
# Resolve its archive explicitly so --static pkg-config metadata cannot introduce an unshipped compiler DSO.
flags = shlex.join('-l:libatomic.a' if flag == '-latomic' else flag for flag in shlex.split(flags))
# librtmp also calls zlib directly, independently of its TLS provider's dependencies.
Path(sys.argv[1]).write_text(flags + ' -lz\n')
