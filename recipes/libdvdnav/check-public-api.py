import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libdvdnav')
read_recipe = recipe.parent / 'libdvdread'
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fixture = runpy.run_path(str(read_recipe / 'fixture.py'))['prepare'](read_recipe, output + '-fixtures')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'dvdnav'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output, str(fixture / 'dvd'), str(fixture / 'owned.iso')],
               check=True, timeout=30, env=environment)
library = library_dir / 'libdvdnav.so.4'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libdvdnav.so.4]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'dvdnav_open', 'dvdnav_get_next_cache_block', 'dvdnav_free_cache_block'} <= names, names
assert not {'DVDOpen', 'DVDReadBlocks', 'ifoOpen'} & names, names
print('libdvdnav: owned folder/ISO, chapters, invalid title, cached buffer ownership and natural STOP passed')
