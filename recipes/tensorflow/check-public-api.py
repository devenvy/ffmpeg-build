import fnmatch
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'shared'
if mode not in {'static', 'shared'}:
    raise SystemExit('Expected static or shared TensorFlow SDK mode')
recipe = Path(os.environ['RECIPES']) / 'tensorflow'
environment = dict(os.environ)
for variable in ['LD_LIBRARY_PATH', 'LIBRARY_PATH']:
    environment.pop(variable, None)
output = Path.cwd() / '_ffb-eager-sdk'
subprocess.run([*shlex.split(os.environ.get('CXX', 'c++')), '-std=c++17', '-fsyntax-only',
                '-I' + str(deps / 'include'), recipe / 'public-headers.cpp'],
               check=True, env=environment)
subprocess.run([*shlex.split(os.environ.get('CC', 'cc')), recipe / 'validate-eager.c',
                '-I' + str(deps / 'include'), '-L' + str(deps / 'lib'), '-ltensorflow',
                *([] if mode == 'shared' else ['@' + str(deps / 'lib/ffb-tensorflow-static.rsp')]),
                '-o', output], check=True, env=environment)
environment.update(LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1',
                   TF_NUM_INTRAOP_THREADS='2', TF_NUM_INTEROP_THREADS='2')
subprocess.run([output], timeout=120, check=True, env=environment)
if mode == 'static':
    print('TensorFlow: native static Graph/Eager closure, public headers and Eager execution passed')
    sys.exit(0)
library = deps / 'lib/libtensorflow.so.2.21.0'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libtensorflow.so.2]' in dynamic, dynamic
assert 'libtensorflow_framework' not in dynamic, dynamic
assert 'libgcc_s.so.1' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
for name in ['TF_NewGraph', 'TF_SessionRun', 'TF_NewTensor', 'TF_DeleteTensor',
             'TFE_NewContext', 'TFE_NewOp', 'TFE_Execute', 'TFE_TensorHandleResolve']:
    assert name in names, name
# Use the native export script, including its leading wildcards, without widening it for C++ implementation symbols.
native = (Path.cwd() / 'tensorflow/c/version_script.lds').read_text()
assert '*TF_*' in native and '*TFE_*' in native and re.search(r'local:\s*\*', native), native
# The upstream globs also preserve native TF/TFE C++ compatibility bridges.
# Check that exact policy rather than suppressing legitimate native exports.
patterns = re.findall(r'^\s*(\*TF_\*|\*TFE_\*);', native, re.M)
versions = set(re.findall(r'^\s*([A-Za-z_][\w.]*)\s*\{', native, re.M))
versions.update({'__start_linkarr_upb_AllExts', '__stop_linkarr_upb_AllExts',
                 '__start_pb_defaults', '__stop_pb_defaults'})
unexpected = sorted(name for name in names if name not in versions and
                    not any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns))
assert not unexpected, unexpected[:30]
print('TensorFlow: native monolithic C/eager SONAME, public API and exact native export policy passed')
