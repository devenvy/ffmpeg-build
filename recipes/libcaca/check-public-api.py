import gzip
import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libcaca')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fixture = Path(output + '-owned.gz')
fixture.write_bytes(gzip.compress(b'Owned compressed terminal SDK fixture\n', mtime=0))
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'caca'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output, str(fixture)], check=True, timeout=30, env=environment)
library = library_dir / 'libcaca.so.0'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libcaca.so.0]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'caca_create_canvas', 'caca_free_canvas', 'caca_file_open', 'caca_file_read'} <= names, names
assert not {'stdscr', 'cur_term', 'initscr', 'wrefresh', 'COLS', 'LINES'} & names, names
assert not any(name.startswith(('inflate', 'deflate', 'adler32', 'crc32')) for name in names), names
print('libcaca: owned canvas/attributes/dither/export/gzip APIs, native SONAME and private curses/zlib symbols passed')
