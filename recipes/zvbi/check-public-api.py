import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, cc = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'zvbi')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--libs', 'zvbi-0.2'], env=environment, text=True))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
for source, compiler in [('public-api.c', cc)]:
    executable = output + ('-c' if source.endswith('.c') else '-cxx')
    command = shlex.split(compiler)
    if source.endswith('.cc'):
        command += ['-std=c++17', '-static-libstdc++', '-shared-libgcc']
    command += [str(recipe / source), '-I' + str(Path(deps, 'include')),
                '-L' + str(library_dir), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', executable]
    subprocess.run(command, check=True, env=environment)
    subprocess.run([executable], check=True, timeout=30, env=environment)
library = library_dir / 'libzvbi.so.0'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libzvbi.so.0]' in dynamic, dynamic
assert 'libstdc++.so' not in dynamic, dynamic
print('zvbi: installed SDK, versioned SONAME and runtime dependencies passed')
