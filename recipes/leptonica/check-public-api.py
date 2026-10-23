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
    ['pkg-config', '--cflags', '--libs', 'lept'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'leptonica', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
dynamic = subprocess.check_output(['readelf', '-d', library_dir / 'libleptonica.so.6'], text=True)
assert '[libleptonica.so.6]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library_dir / 'libleptonica.so.6'], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'LeptDebugOK', 'LeptMsgSeverity', 'setPixMemoryManager', 'pixCreate', 'pixDestroy'} <= names, names
assert not any(name.startswith(('png_', 'inflate', 'deflate')) for name in names), names
print('Leptonica: pixel/refcount/PNG/threshold/scale/public data and native shared ABI passed')
