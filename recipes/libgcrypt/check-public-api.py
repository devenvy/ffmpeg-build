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
    ['pkg-config', '--static', '--cflags', '--libs', 'libgcrypt'], text=True, env=environment))
source = Path(os.environ['RECIPES'], 'libgcrypt', 'public-api.c')
subprocess.run([*shlex.split(compiler), str(source), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)

archive = library_dir / 'libgcrypt.a'
if archive.exists():
    symbols = subprocess.check_output(['nm', '-g', '--defined-only', archive], text=True)
    names = {line.split()[-1] for line in symbols.splitlines() if line.split()}
    generic = {'sha3_256_init', 'sha3_update', 'sha3_final', 'sha3_tester'}
    assert not names.intersection(generic), names.intersection(generic)
    assert not any(name.startswith('_gcry_jent_sha3_') for name in names)
print('Libgcrypt: native SHA3, random-generator operation and unchanged internal names checked')
