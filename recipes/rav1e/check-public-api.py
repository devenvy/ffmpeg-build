import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler, version = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'rav1e'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'rav1e', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=120, env=environment)
parts = version.split('.')
soname = 'librav1e.so.' + '.'.join(parts[:2] if parts[0] == '0' else parts[:1])
library = library_dir / soname
dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
assert '[' + soname + ']' in dynamic, dynamic
executable = subprocess.check_output(['readelf', '-d', output], text=True)
assert '[' + soname + ']' in executable, executable
headers = list(Path(deps, 'include').rglob('rav1e.h'))
assert len(headers) == 1, headers
header = re.sub(r'/\*.*?\*/|//[^\n]*', '', headers[0].read_text(), flags=re.S)
# cbindgen also emits internal architecture-specific extern assembly declarations.
# The public C ABI is the source's unmangled capi.rs functions, not those imports.
source = Path(output).parent.joinpath('src', 'capi.rs').read_text()
required = set(re.findall(r'pub\s+unsafe\s+extern\s+fn\s+(rav1e_\w+)\s*\(', source))
declared = set(re.findall(r'\b(rav1e_\w+)\s*\(', header))
assert required and required <= declared, sorted(required - declared)
symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert required <= names, sorted(required - names)
private = sorted(name for name in names if not name.startswith('rav1e_'))
assert not private, private
assert (library_dir / 'librav1e.a').exists(), 'retain the static archive for existing private Rust isolation'
print('rav1e: native shared SONAME, all ' + str(len(required)) + ' installed C SDK functions and private Rust runtime visibility passed')
