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
    ['pkg-config', '--cflags', '--libs', 'pixman-1'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'pixman', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libpixman-1.so.0'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libpixman-1.so.0]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'pixman_image_create_bits', 'pixman_image_composite32',
        'pixman_region32_init_rect', 'pixman_transform_init_translate'} <= names, names
# Upstream deliberately exports this test-suite entry despite marking it outside the ABI.
native_test_exports = {'_pixman_internal_only_get_implementation'}
assert all(name.startswith('pixman_') or name in native_test_exports for name in names), names
print('Pixman: native SONAME0 and complete native public export visibility passed')
