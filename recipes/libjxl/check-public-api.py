import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, cc, cxx = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
recipe = Path(os.environ['RECIPES'], 'libjxl')
for name, compiler, packages in [
    ('public-api.c', cc, ['libjxl', 'libjxl_threads', 'libjxl_cms', 'libbrotlienc', 'libbrotlidec', 'libbrotlicommon']),
    ('highway-api.cc', cxx, ['libhwy']),
]:
    flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--libs', *packages], env=environment, text=True))
    executable = output + ('-c' if name.endswith('.c') else '-cxx')
    command = shlex.split(compiler)
    if name.endswith('.cc'):
        command += ['-std=c++17', '-static-libstdc++', '-shared-libgcc']
    command += [str(recipe / name), '-I' + str(recipe), '-I' + str(Path(deps, 'include')),
                '-L' + str(library_dir), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', executable]
    subprocess.run(command, check=True, env=environment)
    subprocess.run([executable], check=True, timeout=60, env=environment)

for name in ['libjxl', 'libjxl_threads', 'libjxl_cms']:
    library = library_dir / (name + '.so')
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + '.so.0.12]' in dynamic, dynamic
    assert 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', '--demangle', library], text=True)
    assert 'std::' not in symbols and '__gnu_cxx::' not in symbols, symbols
print('All installed JPEG XL DSOs preserve public APIs and private C++ runtime')
