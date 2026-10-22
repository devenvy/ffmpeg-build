import base64
import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
fixtures = Path(output + '-fonts')
fixtures.mkdir(exist_ok=True)
(fixtures / 'cache').mkdir(exist_ok=True)
font = fixtures / 'owned.ttf'
font.write_bytes(base64.b64decode(Path(os.environ['RECIPES'], 'cairo', 'font.base64').read_text()))
config = fixtures / 'fonts.conf'
config.write_text('<fontconfig><dir>' + str(fixtures) + '</dir><cachedir>' +
                  str(fixtures / 'cache') + '</cachedir></fontconfig>')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1', FONTCONFIG_FILE=str(config))
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'cairo', 'cairo-gobject', 'cairo-script-interpreter',
     'freetype2', 'fontconfig'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'cairo', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output, str(font)], check=True, timeout=60, env=environment)
for name in ['libcairo.so.2', 'libcairo-gobject.so.2', 'libcairo-script-interpreter.so.2']:
    library = library_dir / name
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + ']' in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    private = sorted(symbol for symbol in names if symbol.startswith(('FT_', 'Fc', 'pixman_', 'png_', 'inflate', 'deflate')))
    assert not private, private
assert not list((library_dir / 'cairo').glob('libcairo-trace*'))
assert not list((library_dir / 'cairo').glob('libcairo-fdr*'))
print('Cairo: all three native SDK libraries and private font/image dependency closure passed')
