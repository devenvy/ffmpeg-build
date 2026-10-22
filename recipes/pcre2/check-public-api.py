import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'pcre2')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'libpcre2-8', 'libpcre2-posix'],
    text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
names = set()
for soname in ["libpcre2-8.so.0","libpcre2-posix.so.3"]:
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + soname + ']' in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names.update(line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split())
assert set(["pcre2_compile_8","pcre2_regcomp"]) <= names, names
print('pcre2: installed SDK, native SONAMEs and public data/function exports passed')
