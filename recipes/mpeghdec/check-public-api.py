import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler, version = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'mpeghdec'], text=True, env=environment))
assert '-DMPEGHDEC_STATIC=1' not in flags, flags
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'mpeghdec', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
soname = 'libmpeghdec.so.' + version
library = library_dir / soname
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'mpeghdecoder_init', 'mpeghdecoder_getSamples', 'mpegh_UI_Manager_Open', 'mpegh_UI_GetXmlSceneState'} <= names, sorted(names)
assert all(name.startswith(('mpeghdecoder_', 'mpegh_UI_')) for name in names), sorted(names)
print('MPEG-H: both public SDK namespaces, engine full-version SONAME and private C++/FDK closure passed')
