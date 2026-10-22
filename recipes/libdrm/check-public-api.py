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
    ['pkg-config', '--cflags', '--libs', 'libdrm'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'libdrm', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
for name in ["libdrm.so.2"]:
    library = library_dir / name
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
print('libdrm: complete native SONAME inventory and public SDK software contracts passed')
