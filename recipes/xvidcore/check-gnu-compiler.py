"""Verify that the selected Clang uses the existing GNU MinGW headers and CRT."""
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

compiler = shlex.split(os.environ['CC'])
reference = [os.environ['CROSS_HOST'] + '-gcc-win32']
if subprocess.check_output(reference + ['-dumpmachine'], text=True).strip() != os.environ['CROSS_HOST']:
    raise SystemExit('GNU compiler target differs from the requested MinGW host')
flags = shlex.split(os.environ.get('CPPFLAGS', '')) + shlex.split(os.environ.get('CFLAGS', ''))
runtime_directories = set()
for library in ['libgcc.a', 'libgcc_eh.a']:
    archive = Path(subprocess.check_output(reference + ['-print-file-name=' + library],
                                           text=True).strip())
    if not archive.is_absolute() or not archive.is_file():
        raise SystemExit('GNU compiler did not provide its native runtime archive: ' + str(archive))
    runtime_directories.add(str(archive.parent))
link_flags = shlex.split(os.environ.get('LDFLAGS', '')) + [
    '-L' + directory for directory in sorted(runtime_directories)]


def macros(command):
    output = subprocess.check_output(command + flags + ['-dM', '-E', '-include', '_mingw.h', '-x', 'c', '-'],
                                     input='', text=True)
    return dict(re.findall(r'^#define (\w+)(?: (.*))?$', output, re.M))


actual = macros(compiler)
expected = macros(reference)
for name in ['__MINGW64_VERSION_MAJOR', '__MINGW64_VERSION_MINOR', '__MSVCRT_VERSION__',
             '_UCRT', '__SIZEOF_POINTER__', '__SIZEOF_LONG_DOUBLE__']:
    if actual.get(name) != expected.get(name):
        raise SystemExit('Selected Clang differs from GNU MinGW for ' + name + ': ' +
                         repr(actual.get(name)) + ' != ' + repr(expected.get(name)))
if '__MINGW64_VERSION_MAJOR' not in actual:
    raise SystemExit('Selected compiler did not include the native GNU MinGW headers')
trace = subprocess.run(compiler + flags + ['-###', '-c', '-x', 'c', '-'], input='',
                       text=True, capture_output=True, check=True).stderr
if '/usr/x86_64-w64-mingw32/include' not in trace:
    raise SystemExit('Clang did not select the explicit GNU MinGW sysroot: ' + trace)
if re.search(r'/opt/llvm-mingw/(?:x86_64-w64-mingw32|generic-w64-mingw32)/include', trace):
    raise SystemExit('Clang selected bundled UCRT headers: ' + trace)
print('Native Clang uses GNU MinGW SDK/CRT macros matching GCC; archive and final link retain GNU tools')
with tempfile.TemporaryDirectory(prefix='ffb-compiler-link-', dir=Path.cwd()) as directory:
    source = Path(directory) / 'main.c'
    executable = Path(directory) / 'main.exe'
    source.write_text('int main(void) { return 0; }\n')
    result = subprocess.run(compiler + flags + link_flags +
                            [str(source), '-o', str(executable)],
                            text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise SystemExit('Native GNU-SDK Clang link probe failed:\n' + result.stdout + result.stderr)
subprocess.run(['./configure', *sys.argv[1:]], check=True,
               env=dict(os.environ, LDFLAGS=shlex.join(link_flags)))
