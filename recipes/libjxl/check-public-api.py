import os
from pathlib import Path
import re
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

has_system_cxx = False
runtime_versions = set()
for name in ['libjxl', 'libjxl_threads', 'libjxl_cms']:
    library = library_dir / (name + '.so')
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + '.so.0.12]' in dynamic, dynamic
    has_system_cxx |= 'libstdc++.so.6' in dynamic
    versions = subprocess.check_output(['readelf', '--version-info', library], text=True)
    runtime_versions.update(re.findall(r'\b(?:GLIBCXX|CXXABI)_\d+(?:\.\d+)*', versions))
assert has_system_cxx, 'Native JPEG XL shared libraries must retain their selected C++ runtime dependency'
print('All installed JPEG XL DSOs preserve public APIs and the native system C++ runtime')
print('JPEG XL compiler runtime requirements: ' + ', '.join(sorted(runtime_versions)))
