import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
with tempfile.TemporaryDirectory(prefix='ffb-opencl-empty-') as vendors:
    environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                       LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1',
                       OCL_ICD_VENDORS=vendors, OCL_ICD_FILENAMES='')
    flags = shlex.split(subprocess.check_output(
        ['pkg-config', '--cflags', '--libs', 'OpenCL'], text=True, env=environment))
    subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'opencl-icd-loader', 'public-api.c')),
                    *flags, '-o', output], check=True, env=environment)
    subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libOpenCL.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libOpenCL.so.1]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
assert 'clGetPlatformIDs@@OPENCL_1.0' in symbols and 'clCreateContext@@OPENCL_1.0' in symbols, symbols
print('OpenCL: installed native versioned SDK and explicitly empty ICD discovery passed; computation is tested separately with PoCL')
