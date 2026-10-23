import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'vid.stab')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--cflags', '--libs', 'vidstab'], text=True, env=environment))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
command = shlex.split(compiler) + []
command += [str(recipe / 'public-api.c'), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', output]
subprocess.run(command, check=True, env=environment)
arguments = [output]
subprocess.run(arguments, check=True, timeout=30, env=environment)
library = library_dir / 'libvidstab.so.1.2'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libvidstab.so.1.2]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1] for line in symbols.splitlines() if line.split()}
assert {'vs_log', 'vs_log_level', 'vs_malloc', 'vs_realloc', 'vs_free', 'vs_zalloc', 'vs_strdup', 'VS_ERROR_TYPE', 'VS_WARN_TYPE', 'VS_INFO_TYPE', 'VS_MSG_TYPE', 'VS_ERROR', 'VS_OK'} <= names
print('vid.stab: installed SDK, SONAME and runtime/export checks passed')
