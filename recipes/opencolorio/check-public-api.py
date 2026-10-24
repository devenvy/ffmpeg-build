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
assert '[' + soname + ']' in dynamic and '[libstdc++.so.6]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
private = sorted(name for name in names if name.startswith(('inflate', 'deflate', 'crc32', 'adler32')))
assert not private, private
# Shared dependencies may provide the common compiler ABI; the public callers
# below verify actual state ownership rather than requiring duplicate definitions.
assert 'libgcc_s.so.1' in dynamic, dynamic
for mode, runtime_flags in [('dynamic', []), ('static', ['-static-libstdc++', '-shared-libgcc'])]:
    probe = output + '-exception-' + mode
    subprocess.run([*shlex.split(compiler), '-std=c++17',
                    str(Path(os.environ['RECIPES'], 'opencolorio', 'public-exception.cpp')),
                    *flags, *runtime_flags, '-o', probe], check=True, env=environment)
    subprocess.run([probe], timeout=30, check=True, env=environment)
print('OpenColorIO: native public C++ ownership, shared exception state and private dependency closure passed')
