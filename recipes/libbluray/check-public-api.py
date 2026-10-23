import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libbluray')
udf_recipe = recipe.parent / 'libudfread'
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fixture = runpy.run_path(str(udf_recipe / 'fixture.py'))['prepare'](udf_recipe, output + '-fixtures')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'libbluray'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output, str(fixture / 'disc'), str(fixture / 'owned.iso'),
                str(fixture / 'disc/BDMV/STREAM/00000.m2ts')], check=True, timeout=30, env=environment)
library = library_dir / 'libbluray.so.4'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libbluray.so.4]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'bd_open', 'bd_read', 'bd_read_file', 'bd_get_title_info', 'bd_free_title_info'} <= names, names
assert not any(name.startswith(('udfread_', 'xml', 'inflate', 'deflate', 'adler32', 'crc32')) for name in names), names
print('libbluray: owned folder/ISO, exact raw file and bounded PID normalization, metadata/EOF/seek/ownership and private dependency exports passed')
