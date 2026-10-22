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
    ['pkg-config', '--cflags', '--libs', 'openal'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'openal-soft', 'public-api.c')),
                *flags, '-lm', '-o', output], check=True, env=environment)
subprocess.run([output], check=True, timeout=30, env=environment)
library = library_dir / 'libopenal.so.1'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libopenal.so.1]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'alGenSources', 'alcOpenDevice', 'alcCaptureOpenDevice',
        'alcLoopbackOpenDeviceSOFT', 'alcRenderSamplesSOFT'} <= names, names
assert not any(name.startswith(('snd_', '_Z', 'ffb_')) for name in names), names
print('OpenAL: native public exports and private ALSA/C++ closure passed')
