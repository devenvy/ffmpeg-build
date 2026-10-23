"""Preserve the complete installed AAC and auxiliary C SDK, hiding private DSP symbols."""

import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "fdk-aac"
symbols = (source / "exports.map").read_text().split('global:')[1].split('local:')[0]
expected = set(re.findall(r'\b([A-Za-z_]\w*)\s*;', symbols))
library = deps / 'lib' / 'libfdk-aac.so'
defined = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
actual = {line.split()[-1].split('@')[0] for line in defined.splitlines() if line.split()}
if actual != expected:
    raise SystemExit(f'FDK installed C SDK exports changed: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}')
dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
if 'libstdc++' in dynamic:
    raise SystemExit('FDK AAC unexpectedly requires a C++ runtime')
subprocess.run([
    *shlex.split(os.environ.get('CC', 'gcc')), str(source / 'public-api.c'),
    f"-I{deps / 'include'}", f"-L{deps / 'lib'}", '-lfdk-aac', '-lm', '-o', str(program),
], check=True)
subprocess.run([str(program), str(program.with_suffix('.bin'))], check=True, env={
    **os.environ, 'LD_LIBRARY_PATH': str(deps / 'lib')
})
print(f'FDK complete installed C SDK: {len(expected)} exports and external AAC/memory/file/channel-map API passed')
