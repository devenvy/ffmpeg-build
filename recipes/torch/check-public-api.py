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
                '-static-libstdc++', '-shared-libgcc', '-o', str(output)], check=True, env=environment)
subprocess.run([str(output)], timeout=120, check=True, env=environment)
bridges = {'_ZSt9to_stringB5cxx11RKN5torch3jit10tensorexpr6TensorE',
           '_ZSt9to_stringB5cxx11RKSt10shared_ptrIN5torch3jit10tensorexpr4ExprEE',
           '_ZSt9to_stringB5cxx11RKSt10shared_ptrIN5torch3jit10tensorexpr4StmtEE'}
for component in ['libtorch', 'libtorch_cpu', 'libc10', 'libtorch_global_deps']:
    library = deps / ('lib/' + component + '.so.2.14')
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    assert '[' + component + '.so.2.14]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    private = sorted(name for name in names if
                     ('6google8protobuf' in name or name.startswith(('_ZSt', '_ZNSt', '_ZNKSt')))
                     and name not in bridges)
    assert not private, (component, private[:30])
    if component == 'libtorch_cpu':
        assert bridges <= names, bridges - names
print('Torch: complete four-DSO native C++ CPU owner and private Protobuf/compiler closure passed')
