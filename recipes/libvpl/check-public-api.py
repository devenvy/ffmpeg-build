import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
stub_output = Path(output + '-stub')
subprocess.run(['cmake', '-S', 'libvpl/test/runtimes/stub', '-B', str(stub_output),
                '-DCMAKE_PREFIX_PATH=' + deps, '-DCMAKE_BUILD_TYPE=Release', '-DVPL_SHARED=ON',
                '-DCMAKE_CXX_FLAGS=-static-libstdc++ -shared-libgcc -O2'], check=True)
subprocess.run(['cmake', '--build', str(stub_output), '-j2'], check=True)
assert list(stub_output.glob('libvplstubrt64.so*'))
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1',
                   ONEVPL_PRIORITY_PATH=str(stub_output), ONEVPL_SEARCH_PATH=str(stub_output))
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'vpl'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'libvpl', 'public-api.c')),
                '-I' + str(Path(deps, 'include')), *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libvpl.so.2'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libvpl.so.2]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'MFXLoad', 'MFXUnload', 'MFXEnumImplementations', 'MFXCreateSession', 'MFXClose'} <= names, names
assert not any(name.startswith(('_Z', '__cxa_', 'ffb_')) for name in names), names
pc_version = subprocess.check_output(['pkg-config', '--modversion', 'vpl'], text=True, env=environment).strip()
header = Path(deps, 'include/vpl/mfxdefs.h').read_text()
major = re.search(r'^#define\s+MFX_VERSION_MAJOR\s+(\d+)', header, re.MULTILINE)
minor = re.search(r'^#define\s+MFX_VERSION_MINOR\s+(\d+)', header, re.MULTILINE)
assert major and minor and pc_version.split('.')[:2] == [major[1], minor[1]], pc_version
print('VPL: source-built upstream stub dispatch, complete native ABI/private C++ closure and header-matched SDK version passed')
