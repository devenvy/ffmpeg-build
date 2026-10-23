"""Verify caller replacement allocation with both C++ runtime link choices."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(__file__).resolve().parent
environment = dict(os.environ, LD_LIBRARY_PATH=str(Path(deps, 'lib')), LD_BIND_NOW='1')
control_source = Path(output + '-allocator-control.cc')
control_source.write_text('extern "C" char *allocator_control() { return new char[32]; }\n')
control_library = Path(output + '-allocator-control.so')
# Leave operator new[] unresolved: the native control adds no second C++ runtime.
subprocess.run([*shlex.split(compiler), '-shared', '-fPIC', '-nodefaultlibs',
                str(control_source), '-o', str(control_library)], check=True)
for mode in ('dynamic', 'static'):
    executable = output + '-allocator-' + mode
    command = [*shlex.split(compiler), '-std=c++17', '-shared-libgcc', '-pthread']
    if mode == 'static':
        command.append('-static-libstdc++')
    command += [str(recipe / 'public-allocator.cc'), '-I' + str(Path(deps, 'include')),
                '-L' + str(Path(deps, 'lib')), '-lpystring', str(control_library),
                '-Wl,--export-dynamic', '-Wl,-rpath-link,' + str(Path(deps, 'lib')),
                '-o', executable]
    subprocess.run(command, check=True, env=environment)
    subprocess.run([executable], check=True, timeout=30, env=environment)
