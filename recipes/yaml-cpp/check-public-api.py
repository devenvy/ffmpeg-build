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
assert names and not any(name.startswith(('_ZSt', '_ZNSt', '_ZNSa', '_ZNKSt', '__cxa_')) for name in names), names
print('yaml-cpp: native public C++ ABI/ownership and private static runtime with common unwinder passed')
