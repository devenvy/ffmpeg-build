import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'glib')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1',
                   FFB_CHECK_PRIVATE_PATHS='1')
cc = shlex.split(compiler)

def build(source, destination, packages, extra=()):
    flags = shlex.split(subprocess.check_output(
        ['pkg-config', '--static', '--cflags', '--libs', *packages],
        text=True, env=environment)) if packages else []
    subprocess.run([*cc, str(recipe / source), *flags, *extra,
                    '-Wl,-rpath-link,' + str(library_dir), '-o', destination],
                   check=True, env=environment)

module = output + '-module.so'
build('module.c', module, [], ['-fPIC', '-shared', '-Wl,-z,defs'])
build('public-api.c', output, ['gio-2.0', 'gobject-2.0', 'gmodule-2.0',
                             'glib-2.0', 'libpcre2-8', 'libpcre2-posix', 'libffi'])
subprocess.run([output, module, output + '-payload'], check=True, timeout=30, env=environment)
fixture_dir = Path(output + '-typelibs')
fixture_dir.mkdir()
subprocess.run([str(Path(deps, 'bin', 'gi-compile-repository')),
                '--output=' + str(fixture_dir / 'FfbProbe-1.0.typelib'),
                str(recipe / 'FfbProbe-1.0.gir')], check=True, timeout=30, env=environment)
build('repository-api.c', output + '-repository', ['girepository-2.0'])
subprocess.run([output + '-repository', str(fixture_dir)],
               check=True, timeout=30, env=environment)
for component in ['glib', 'gobject', 'gio', 'gmodule', 'gthread', 'girepository']:
    soname = 'lib' + component + '-2.0.so.0'
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert not any(name.startswith(('ffi_', 'pcre2_')) for name in names), names
    # This hook runs before the engine strips debug information. Inspect runtime
    # constants rather than DWARF's legitimate source-directory records.
    constants = subprocess.check_output(['readelf', '-p', '.rodata', library])
    assert b'/opt/ffmpeg-build/deps' not in constants and b'/work/src/' not in constants, soname
print('GLib: all six installed SDK/runtime libraries and private dependency exports passed')
