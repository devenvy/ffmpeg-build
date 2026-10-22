import os
from pathlib import Path
import shlex
import subprocess
import sys
import base64

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libmysofa')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--cflags', '--libs', 'libmysofa'], text=True, env=environment))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
command = shlex.split(compiler) + []
command += [str(recipe / 'public-api.c'), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', output]
subprocess.run(command, check=True, env=environment)
arguments = [output]
fixture = Path(output + '.sofa')
fixture.write_bytes(base64.b64decode((recipe / 'sofa.base64').read_bytes()))
arguments.append(str(fixture))
subprocess.run(arguments, check=True, timeout=30, env=environment)
library = library_dir / 'libmysofa.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libmysofa.so.1]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1] for line in symbols.splitlines() if line.split()}
assert names and all(name.startswith('mysofa_') for name in names), names
print('libmysofa: installed SDK, SONAME and runtime/export checks passed')
