import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'lensfun')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(['pkg-config', '--static', '--cflags', '--libs', 'lensfun'], text=True, env=environment))
flags = ['-l:libstdc++.a' if flag == '-lstdc++' else flag for flag in flags]
command = shlex.split(compiler) + ['-std=c++17', '-static-libstdc++', '-shared-libgcc', '-pthread']
command += [str(recipe / 'public-api.cc'), *flags, '-Wl,-rpath-link,' + str(library_dir), '-o', output]
subprocess.run(command, check=True, env=environment)
arguments = [output]
arguments.append(str(recipe / 'lens.xml'))
subprocess.run(arguments, check=True, timeout=30, env=environment)
library = library_dir / 'liblensfun.so.2'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[liblensfun.so.2]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
assert not re.search(r'\b(?:g_[a-z]|pcre2_)', symbols), 'Embedded GLib/PCRE symbols escaped the library'
assert 'libgcc_s.so.1' in dynamic, dynamic
# The public C++ API allocates inside the DSO. Keep its native compiler ABI
# preemptible so caller replacement new/delete also owns those allocations.
control_source = Path(output + '-allocator-control.cc')
control_source.write_text('extern "C" char *allocator_control() { return new char[32]; }\n')
control_library = Path(output + '-allocator-control.so')
subprocess.run([*shlex.split(compiler), '-shared', '-fPIC', '-nodefaultlibs', str(control_source),
                '-o', str(control_library)], check=True, env=environment)
for mode in ('dynamic', 'static'):
    allocator_output = output + '-allocator-' + mode
    allocator_flags = flags if mode == 'static' else [flag for flag in flags if flag != '-l:libstdc++.a']
    command = [*shlex.split(compiler), '-std=c++17', '-shared-libgcc', '-pthread']
    if mode == 'static':
        command.append('-static-libstdc++')
    command += [str(recipe / 'public-allocator.cc'), *allocator_flags,
                str(control_library), '-Wl,--export-dynamic',
                '-Wl,-rpath-link,' + str(library_dir), '-o', allocator_output]
    subprocess.run(command, check=True, env=environment)
    subprocess.run([allocator_output], check=True, timeout=30, env=environment)
print('lensfun: installed SDK, SONAME and runtime/export checks passed')
