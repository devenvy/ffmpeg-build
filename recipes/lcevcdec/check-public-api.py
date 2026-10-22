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
    ['pkg-config', '--cflags', '--libs', 'lcevc_dec'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'lcevcdec', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=60, env=environment)
for name in ['liblcevc_dec_api.so.4', 'liblcevc_dec_pipeline_cpu.so.1']:
    dynamic = subprocess.check_output(['readelf', '-d', library_dir / name], text=True)
    assert '[' + name + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library_dir / name], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert names and all(symbol.startswith(('LCEVC_', 'createPipelineBuilder')) for symbol in names), sorted(names)
print('LCEVC: both native shared libraries, export maps and private C++ closure passed')
