import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler, cxx = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'shaderc'], text=True, env=environment))
for suffix, command, extra in [('c', compiler, []), ('cpp', cxx, ['-std=c++17', '-static-libstdc++'])]:
    target = output + '-' + suffix
    subprocess.run([*shlex.split(command),
                    str(Path(os.environ['RECIPES'], 'shaderc', 'public-api.' + suffix)),
                    *extra, *flags, '-o', target], check=True, env=environment)
    subprocess.run([target], check=True, timeout=60, env=environment)
library = library_dir / 'libshaderc_shared.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libshaderc_shared.so.1]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert names and all(name.startswith('shaderc_') for name in names), names
print('shaderc: owned SPIR-V/include callbacks/options/C++ SDK and native public ABI passed')
