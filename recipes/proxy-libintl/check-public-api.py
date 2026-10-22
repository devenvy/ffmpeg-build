import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'proxy-libintl', 'public-api.c')),
                '-I' + str(Path(deps, 'include')), '-L' + str(library_dir),
                '-lintl', '-o', output], check=True, env=environment)
dynamic = subprocess.check_output(['readelf', '-d', output], text=True)
assert '[libintl.so.8]' in dynamic, dynamic
subprocess.run([output], timeout=30, check=True, env=environment)
library = library_dir / 'libintl.so.8'
dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
assert '[libintl.so.8]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
required = {'g_libintl_' + name for name in ['gettext', 'dgettext', 'dcgettext', 'ngettext',
            'dngettext', 'dcngettext', 'textdomain', 'bindtextdomain', 'bind_textdomain_codeset']}
assert required | {'_nl_msg_cat_cntr'} <= names, sorted(required - names)
print('Proxy gettext: complete native shared C SDK and SONAME passed; translation catalogs remain unsupported')
