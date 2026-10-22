import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = ['-I' + str(Path(deps, 'include')), '-L' + str(library_dir), '-lxavs', '-lm']
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'xavs', 'public-api.c')),
                *flags, '-lm', '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=60, env=environment)
library = library_dir / 'libxavs.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libxavs.so.1]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert names and all(name.startswith('xavs_') for name in names), names
assert 'xavs_levels' in names, names
print('xavs: native SONAME and public SDK exports with private runtime closure passed')
