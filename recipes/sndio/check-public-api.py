import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'sndio'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'sndio', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
with tempfile.TemporaryDirectory(prefix='ffb-sndio-') as folder:
    root = Path(folder)
    pattern = bytes((i * 17 + 31) % 251 for i in range(48000 * 4))
    (root / 'capture.raw').write_bytes(pattern)
    config = '''pcm.hw {
      @args [ CARD DEV SUBDEV ]
      @args.CARD { type string default "0" }
      @args.DEV { type integer default 0 }
      @args.SUBDEV { type integer default -1 }
      type file
      slave.pcm { type null }
      file "ROOT/playback.raw"
      infile "ROOT/capture.raw"
      format "raw"
    }'''.replace('ROOT', str(root))
    (root / 'asound.conf').write_text(config)
    environment['ALSA_CONFIG_PATH'] = str(root / 'asound.conf')
    subprocess.run([output], check=True, timeout=30, env=environment)
    playback = (root / 'playback.raw').read_bytes()
    assert len(playback) >= 9600 and playback[:9600] == pattern[:9600], playback[:32]
library = library_dir / 'libsndio.so.7'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libsndio.so.7]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'sio_open', 'sio_read', 'sio_write', 'mio_open', 'sioctl_open'} <= names, names
assert not any(name.startswith(('snd_', '_Z', 'strl')) for name in names), names
print('sndio: native SONAME7, exact playback readback and private ALSA closure passed')
