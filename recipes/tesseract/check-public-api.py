import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'tesseract', 'lept'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), '-std=c++17', '-static-libstdc++',
                str(Path(os.environ['RECIPES'], 'tesseract', 'public-api.cpp')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libtesseract.so.5.5'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libtesseract.so.5.5]' in dynamic and '[libleptonica.so.6]' in dynamic, dynamic
assert 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'TessBaseAPICreate', 'TessBaseAPIDelete'} <= names, names
private = sorted(name for name in names if name.startswith(('pixCreate', 'pixDestroy', '__cxa_', '_ZNSt')))
assert not private, private
print('Tesseract: model-free C/C++ SDK and tracked cross-library pixel allocator ownership passed')
