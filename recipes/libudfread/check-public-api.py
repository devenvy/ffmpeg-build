import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libudfread')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fixture = runpy.run_path(str(recipe / 'fixture.py'))['prepare'](recipe, output + '-fixtures')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'libudfread'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output, str(fixture / 'owned.iso'), str(fixture / 'disc/BDMV/STREAM/00000.m2ts')],
               check=True, timeout=30, env=environment)
library = library_dir / 'libudfread.so.3'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libudfread.so.3]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'udfread_open', 'udfread_open_input', 'udfread_file_read', 'udfread_close'} <= names, names
print('libudfread: owned UDF image, directory/file reads, external callback lifetime, exact bytes and native SONAME passed')
