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
    ['pkg-config', '--cflags', '--libs', 'yaml-cpp'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), '-std=c++17', '-static-libstdc++',
                str(Path(os.environ['RECIPES'], 'yaml-cpp', 'public-api.cpp')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libyaml-cpp.so.0.9'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libyaml-cpp.so.0.9]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'__cxa_get_globals', '__cxa_throw'} <= names, names
assert 'libgcc_s.so.1' in dynamic, dynamic
for mode, runtime_flags in [('dynamic', []), ('static', ['-static-libstdc++', '-shared-libgcc'])]:
    probe = output + '-exception-' + mode
    subprocess.run([*shlex.split(compiler), '-std=c++17',
                    str(Path(os.environ['RECIPES'], 'yaml-cpp', 'public-exception.cpp')),
                    *flags, *runtime_flags, '-o', probe], check=True, env=environment)
    subprocess.run([probe], timeout=30, check=True, env=environment)
print('yaml-cpp: native public C++ ownership, shared exception state and retained exception lifetime passed')
