import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import zipfile

deps, output, compiler = sys.argv[1:]
library_dir = Path(deps, 'lib')
environment = dict(os.environ, PKG_CONFIG_PATH=str(library_dir / 'pkgconfig'),
                   LD_LIBRARY_PATH=str(library_dir), LD_BIND_NOW='1')
flags = shlex.split(subprocess.check_output(
    ['pkg-config', '--cflags', '--libs', 'minizip-ng'], text=True, env=environment))
subprocess.run([*shlex.split(compiler), str(Path(os.environ['RECIPES'], 'minizip-ng', 'public-api.c')),
                *flags, '-o', output], check=True, env=environment)
with tempfile.TemporaryDirectory(prefix='ffb-minizip-') as folder:
    root = Path(folder)
    payload = b'Owned compressed archive SDK fixture\n'
    with zipfile.ZipFile(root / 'good.zip', 'w') as archive:
        archive.writestr('stored.txt', payload, compress_type=zipfile.ZIP_STORED)
        archive.writestr('deflated.txt', payload, compress_type=zipfile.ZIP_DEFLATED)
    corrupted = bytearray((root / 'good.zip').read_bytes())
    offset = corrupted.index(payload)
    corrupted[offset] ^= 1
    (root / 'bad.zip').write_bytes(corrupted)
    subprocess.run([output, str(root / 'good.zip'), str(root / 'bad.zip'), str(root / 'native.zip')],
                   check=True, timeout=30, env=environment)
    with zipfile.ZipFile(root / 'native.zip') as archive:
        assert archive.read('native.txt') == payload
library = library_dir / 'libminizip-ng.so.4'
dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
assert '[libminizip-ng.so.4]' in dynamic, dynamic
symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert {'mz_zip_reader_create', 'mz_zip_writer_create', 'mz_stream_mem_seek'} <= names, names
assert not any(name.startswith(('deflate', 'inflate', 'crc32', '_Z')) for name in names), names
print('Minizip: native SONAME4, full zip/stream SDK and private zlib closure passed')
