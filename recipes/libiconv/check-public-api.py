import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
environment = dict(os.environ, DYLD_LIBRARY_PATH=str(Path(deps, 'lib')))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'libiconv', 'public-api.c')),
                '-I' + str(Path(deps, 'include')), '-L' + str(Path(deps, 'lib')),
                '-liconv', '-o', output], check=True, env=environment)
dynamic = subprocess.check_output(['otool', '-L', output], text=True)
assert 'libiconv.2.dylib' in dynamic and '/usr/lib/libiconv' not in dynamic, dynamic
subprocess.run([output], timeout=30, check=True, env=environment)
library = Path(deps, 'lib/libiconv.2.dylib')
symbols = subprocess.check_output(['nm', '-gU', str(library)], text=True)
for name in ['_libiconv_open', '_libiconv', '_libiconv_close', '_libiconvlist', '__libiconv_version']:
    assert any(line.split()[-1] == name for line in symbols.splitlines() if line.split()), name
print('GNU iconv: native Apple dylib ABI and GNU rather than system SDK provider passed')
