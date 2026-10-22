import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'ncurses')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'panelw', 'menuw', 'formw', 'ncursesw'],
    text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run(['python3', str(recipe / 'run-pty.py'), output + '-pty.bin', output],
               check=True, timeout=40, env=environment)
for name in ['libncursesw.so.6', 'libpanelw.so.6', 'libmenuw.so.6', 'libformw.so.6']:
    library = library_dir / name
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + ']' in dynamic and 'libgpm' not in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library_dir / 'libncursesw.so.6'], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'stdscr', 'curscr', 'newscr', 'COLS', 'LINES', 'COLORS', 'COLOR_PAIRS',
        'ESCDELAY', 'TABSIZE', 'ttytype', 'acs_map', 'cur_term', 'boolnames', 'strnames'} <= names, names
print('ncurses: four native DSOs, wide public SDK/data/addons/two-screen lifetime and exact PTY restoration passed')
