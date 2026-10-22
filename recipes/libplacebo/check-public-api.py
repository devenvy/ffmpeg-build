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
    ['pkg-config', '--cflags', '--libs', 'libplacebo'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'libplacebo', 'public-api.c')),
                *flags, '-lm', '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libplacebo.so.360'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libplacebo.so.360]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
assert 'libvulkan.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert names and all(name.startswith('pl_') for name in names), names
assert {'pl_log_default_params', 'pl_color_space_srgb', 'pl_matrix3x3_identity'} <= names, names
print('libplacebo: public data/CPU SDK/native SONAME/private C++ and caller-owned Vulkan loader passed')
