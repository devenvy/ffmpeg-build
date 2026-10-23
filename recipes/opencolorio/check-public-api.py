import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler, version = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'OpenColorIO'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), '-std=c++17',
                str(Path(os.environ['RECIPES'], 'opencolorio', 'public-api.cpp')),
                *flags, '-static-libstdc++', '-shared-libgcc', '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=60, env=environment)
soname = 'libOpenColorIO.so.' + '.'.join(version.split('.')[:2])
library = library_dir / soname
dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
private = sorted(name for name in names if name.startswith(('_ZSt', '_ZNSt', '_ZNKSt', 'inflate', 'deflate', 'crc32', 'adler32')))
assert not private, private
print('OpenColorIO: native versioned shared SDK, complete public C++ ownership and private dependency/compiler closure passed')
