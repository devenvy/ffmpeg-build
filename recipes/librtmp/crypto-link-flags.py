"""Preserve GnuTLS's actual static dependency closure for librtmp's shared link."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

command = shlex.split(os.environ.get('PKG_CONFIG', 'pkg-config'))
flags = subprocess.check_output(command + ['--static', '--libs', 'gnutls'], text=True).strip()
if not flags or '\n' in flags or '\r' in flags or '\0' in flags:
    raise SystemExit('Expected one non-empty GnuTLS pkg-config link line')
# librtmp's GnuTLS path also calls zlib directly, independently of GnuTLS's dependencies.
Path(sys.argv[1]).write_text(flags + ' -lz\n')
