import base64
import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'librsvg')
library_dir = Path(deps, 'lib')
fixtures = Path(output + '-fonts')
fixtures.mkdir(exist_ok=True)
font = fixtures / 'owned.ttf'
font.write_bytes(base64.b64decode((recipe / 'font.base64').read_text()))
config = fixtures / 'fonts.conf'
config.write_text('<fontconfig><dir>' + str(fixtures) + '</dir><cachedir>' +
                  str(fixtures / 'cache') + '</cachedir></fontconfig>')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1',
                   FONTCONFIG_FILE=str(config), G_DEBUG='fatal-warnings')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'librsvg-2.0', 'pangocairo',
     'pangoft2', 'harfbuzz', 'fontconfig'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags, '-o', output],
               check=True, env=environment)
for order in ['svg-first', 'pango-first']:
    subprocess.run([output, str(font), order], check=True, timeout=60, env=environment)
for soname in ['librsvg-2.so.2', 'libpango-1.0.so.0', 'libpangoft2-1.0.so.0', 'libpangocairo-1.0.so.0']:
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    assert '[' + soname + ']' in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    private = sorted(name for name in names if not name.startswith(('rsvg_', 'pango_', 'LIBRSVG_')))
    assert not private, (soname, private)
print('Pango/librsvg: complete native four-DSO SDK and common GObject/font/shape owners passed')
