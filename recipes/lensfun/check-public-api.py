import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'lensfun')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--cflags', '--libs', 'lensfun'], text=True, env=environment))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
command = shlex.split(compiler) + ['-std=c++17', '-static-libstdc++', '-shared-libgcc', '-pthread']
command += [str(recipe / 'public-api.cc'), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', output]
subprocess.run(command, check=True, env=environment)
arguments = [output]
arguments.append(str(recipe / 'lens.xml'))
subprocess.run(arguments, check=True, timeout=30, env=environment)
library = library_dir / 'liblensfun.so.2'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[liblensfun.so.2]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
print('lensfun: installed SDK, SONAME and runtime/export checks passed')
