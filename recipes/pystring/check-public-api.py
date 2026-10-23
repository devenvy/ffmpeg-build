import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = ['-I' + str(Path(deps, 'include')), '-L' + str(library_dir), '-lpystring']
subprocess.run([*shlex.split(compiler), '-std=c++17', '-static-libstdc++',
                str(Path(os.environ['RECIPES'], 'pystring', 'public-api.cpp')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libpystring.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libpystring.so.1]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert 'libgcc_s.so.1' in dynamic, dynamic
assert names and not any(name.startswith('_Unwind_') for name in names), names
subprocess.run([sys.executable, str(Path(os.environ['RECIPES'], 'pystring', 'check-allocator.py')),
                deps, output, compiler], check=True)
print('pystring: native public C++ ABI, caller allocator ownership and common unwinder passed')
