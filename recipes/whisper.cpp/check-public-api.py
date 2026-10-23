import os
from pathlib import Path
import shlex
import subprocess
import sys

deps, output, compiler, backend = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'whisper'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'whisper.cpp', 'public-api.c')),
                *flags, '-lparakeet', '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=60, env=environment)
expected = ['libwhisper.so.1', 'libparakeet.so.1', 'libggml.so.0', 'libggml-base.so.0', 'libggml-cpu.so.0']
if backend == 'vulkan':
    expected.append('libggml-vulkan.so.0')
for soname in expected:
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(library)], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    private = sorted(name for name in names if name.startswith(('vk', '_ZSt', '_ZNSt', '_ZNKSt')))
    assert not private, (soname, private)
print('Whisper: complete native CPU/registry/optional Vulkan/Parakeet SDK and private compiler/loader closure passed')
