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
    ['pkg-config', '--cflags', '--libs', 'libva-drm'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'libva', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
for name in ["libva.so.2","libva-drm.so.2"]:
    library = library_dir / name
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library_dir / 'libva-drm.so.2'], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert not any(name.startswith(('drm', '_Z')) for name in names), names
print('libva: complete native SONAME inventory and public SDK software contracts passed')
