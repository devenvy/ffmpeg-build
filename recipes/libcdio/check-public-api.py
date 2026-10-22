import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import shlex
import struct
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
recipe = Path(os.environ['RECIPES'], 'libcdio')
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
fixtures = Path(output + '-fixtures')
fixtures.mkdir(exist_ok=True)
audio = bytearray(750 * 588 * 4)
for index in range(750 * 588):
    left = (index % 441) * 40000 // 441 - 20000
    right = (index % 293) * 24000 // 293 - 8000
    struct.pack_into('<hh', audio, index * 4, left, right)
bin_file = fixtures / 'authored.bin'
bin_file.write_bytes(audio)
cue = fixtures / 'authored.cue'
cue.write_text('FILE "authored.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n')
arguments = [str(cue), str(bin_file)]
metadata = json.loads((recipe / 'iso-fixture.json').read_text())
image = gzip.decompress(base64.b64decode((recipe / 'iso.base64').read_bytes()))
assert hashlib.sha256(image).hexdigest() == metadata['imageSha256']
iso = fixtures / 'owned.iso'
iso.write_bytes(image)
arguments.append(str(iso))
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--static', '--cflags', '--libs', 'libcdio', 'libiso9660', 'libudf'],
    text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(recipe / 'public-api.c'), *flags,
                '-lcdio', '-Wl,-rpath-link,' + str(library_dir), '-o', output], check=True, env=environment)
subprocess.run([output, *arguments], check=True, timeout=30, env=environment)
for soname in ["libcdio.so.21","libiso9660.so.13","libudf.so.0"]:
    library = library_dir / soname
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + soname + ']' in dynamic and 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert names, soname
    if soname == 'libcdio.so.21':
        assert {'cdio_open', '_cdio_list_length', 'CDIO_SECTOR_SYNC_HEADER'} <= names, names
    else:
        assert 'cdio_open' not in names and 'CDIO_SECTOR_SYNC_HEADER' not in names, names
print('libcdio: owned image/SDK probes, complete native SONAME inventory and private dependency exports passed')
