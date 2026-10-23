import os
from pathlib import Path
import shlex
import subprocess
import sys

deps = Path(sys.argv[1])
library = deps / 'lib/libonnxruntime.so.1'
bridge = deps / 'lib/libonnxruntime_providers_shared.so'
environment = dict(os.environ, LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1')
model = Path.cwd() / 'ffb-identity.onnx'
model.write_bytes(bytes.fromhex('08083a560a100a017812017922084964656e7469747912086964656e746974795a1b0a017812160a14080112100a0208010a0208030a0208020a020802621b0a017912160a14080112100a0208010a0208030a0208020a0208024202100d'))
output = Path.cwd() / 'ffb-sdk'
subprocess.run([*shlex.split(os.environ.get('CXX', 'g++')), '-std=c++17',
                str(Path(os.environ['RECIPES'], 'onnxruntime/public-api.cpp')),
                '-I' + str(deps / 'include'), '-L' + str(deps / 'lib'), '-lonnxruntime',
                '-ldl', '-pthread', '-static-libstdc++', '-shared-libgcc', '-o', str(output)], check=True, env=environment)
subprocess.run([str(output), str(model), str(bridge)], timeout=120, check=True, env=environment)
for path in [library, bridge]:
    dynamic = subprocess.check_output(['readelf', '-d', str(path)], text=True)
    assert 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(path)], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert not any(name.startswith(('_ZSt', '_ZNSt', '_ZNKSt', 'google', '_ZN6google')) for name in names), names
assert '[libonnxruntime.so.1]' in subprocess.check_output(['readelf', '-d', str(library)], text=True)
print('ONNX Runtime: complete native runtime/provider bridge and private dependency/compiler ABI checks passed')
