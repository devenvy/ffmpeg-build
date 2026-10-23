import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libavc1394')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'libavc1394', 'libraw1394'],
    text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-lrom1394', '-lraw1394', '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
for soname in ["libavc1394.so.0","librom1394.so.0"]:
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic and 'libusb' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert names, soname
    if 'libavc1394' != 'libraw1394':
        assert not any(symbol.startswith('raw1394_') for symbol in names), names
print('libavc1394: hardware-free public SDK, native SONAMEs and private dependency exports passed')
