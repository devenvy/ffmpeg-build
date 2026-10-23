import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'zix')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'zix-0'],
    text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
soname = 'libzix-0.so.0'
library = library_dir / soname
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert names and any(symbol.startswith('zix_') for symbol in names), names
other = set(['lilv', 'serd', 'sord', 'sratom', 'zix']) - {'zix'}
assert not any(symbol.startswith(prefix + '_') for symbol in names for prefix in other), names
constants = subprocess.check_output(['readelf', '-p', '.rodata', library])
assert b'/opt/ffmpeg-build/deps' not in constants, soname
print('zix: installed SDK, native SONAME and private dependency exports passed')
