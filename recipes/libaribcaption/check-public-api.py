import os
from pathlib import Path
import shlex
import subprocess
import sys
import base64

deps, output, cc, cxx = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libaribcaption')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fonts = Path(output + '-fonts')
fonts.mkdir(parents=True, exist_ok=True)
(fonts / 'test.ttf').write_bytes(base64.b64decode((recipe / 'font.base64').read_bytes()))
config = fonts / 'fonts.conf'
config.write_text('<fontconfig><dir>' + str(fonts) + '</dir><cachedir>' + str(fonts / 'cache') + '</cachedir></fontconfig>')
environment['FONTCONFIG_FILE'] = str(config)
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--libs', 'libaribcaption'], env=environment, text=True))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
for source, compiler in [('public-api.c', cc), ('public-api.cc', cxx)]:
    executable = output + ('-c' if source.endswith('.c') else '-cxx')
    command = shlex.split(compiler)
    if source.endswith('.cc'):
        command += ['-std=c++17', '-static-libstdc++', '-shared-libgcc']
    command += [str(recipe / source), '-I' + str(Path(deps, 'include')),
                '-L' + str(library_dir), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', executable]
    subprocess.run(command, check=True, env=environment)
    subprocess.run([executable], check=True, timeout=30, env=environment)
library = library_dir / 'libaribcaption.so.1.1.2'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libaribcaption.so.1.1.2]' in dynamic, dynamic
assert 'libstdc++.so' not in dynamic, dynamic
assert 'libgcc_s.so.1' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', '--demangle', library], text=True)
for line in symbols.splitlines():
    symbol = line.split(maxsplit=2)[2]
    assert not symbol.startswith(('FT_', 'Fc', 'XML_', 'png_', 'inflate', 'deflate', 'crc32', 'adler32')), symbol
subprocess.run([sys.executable, str(recipe / 'check-allocator.py'), deps, output, cxx], check=True)
print('libaribcaption: installed SDK, versioned SONAME and runtime dependencies passed')
