import os
from pathlib import Path
import shlex
import subprocess
import sys

deps = Path(sys.argv[1])
environment = dict(os.environ, PKG_CONFIG_PATH=str(deps / 'lib/pkgconfig'),
                   LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--cflags', '--libs', 'torch'],
                                           text=True, env=environment))
output = Path.cwd() / 'ffb-sdk'
subprocess.run([*shlex.split(os.environ.get('CXX', 'g++')),
                str(Path(os.environ['RECIPES'], 'torch/public-api.cpp')), *flags,
                '-UNDEBUG', '-shared-libgcc', '-o', str(output)], check=True, env=environment)
subprocess.run([str(output)], timeout=120, check=True, env=environment)
# Test the complete native CMake SDK after moving its installation prefix.
# The recipe's byte-identical native install is separate from the dependency prefix.
installed = Path.cwd() / '_install'
moved = Path.cwd() / '_sdk-moved'
installed.rename(moved)
try:
    clean = dict(os.environ)
    for name in ['TORCH_INSTALL_PREFIX', 'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'CMAKE_PREFIX_PATH']:
        clean.pop(name, None)
    sdk = Path.cwd() / '_sdk-consumer'
    subprocess.run(['cmake', '-S', str(Path(os.environ['RECIPES'], 'torch/sdk-consumer')),
                    '-B', str(sdk), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
                    '-DCMAKE_PREFIX_PATH=' + str(moved),
                    '-DTorch_DIR=' + str(moved / 'share/cmake/Torch')], check=True, env=clean)
    subprocess.run(['cmake', '--build', str(sdk), '--parallel', os.environ['JOBS']], check=True, env=clean)
    subprocess.run([str(sdk / 'torch-sdk')], timeout=120, check=True,
                   env=dict(clean, LD_LIBRARY_PATH=str(moved / 'lib'), LD_BIND_NOW='1'))
finally:
    moved.rename(installed)
standard_runtime = False
for component in ['libtorch', 'libtorch_cpu', 'libc10', 'libtorch_global_deps']:
    library = deps / ('lib/' + component + '.so.2.7')
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    assert '[' + component + '.so.2.7]' in dynamic, dynamic
    standard_runtime |= 'libstdc++.so.6' in dynamic
assert standard_runtime, 'Native shared Torch must use its system C++ runtime'
print('Torch: four native CPU owners, public tensor/JIT/exception API and system C++ runtime passed')
