"""Install the client DSO closure with relative paths and isolated static crypto."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess

deps = Path(os.environ['DEPS_DIR'])
lib = deps / 'samba/lib'
lib.mkdir(parents=True, exist_ok=True)
system = {'libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2',
          'libresolv.so.2', 'librt.so.1', 'ld-linux-x86-64.so.2'}
private_crypto = {'gnutls_init', 'gnutls_deinit', 'gnutls_global_init',
                  'gnutls_cipher_init', 'gnutls_cipher_deinit',
                  'asn1_array2tree', 'nettle_aes128_encrypt', '__gmpz_init'}
libraries = {}
for path in sorted(Path('bin/default').rglob('*.so*')):
    if not path.is_file():
        continue
    dynamic = subprocess.check_output(['readelf', '-d', str(path)], text=True)
    soname = re.search(r'\(SONAME\).*\[(.*?)\]', dynamic)
    # Upstream's build-only private DSOs have no SONAME until installation.
    name = soname[1] if soname else path.name
    if Path(name).name != name:
        raise SystemExit('Invalid Samba shared library soname: ' + name)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if name in libraries:
        if libraries[name]['digest'] != digest:
            raise SystemExit('Different Samba binaries have the same soname: ' + name)
        continue
    needed = re.findall(r'\(NEEDED\).*\[(.*?)\]', dynamic)
    libraries[name] = {'path': path, 'digest': digest, 'needed': needed}

used = set()
pending = ['libsmbclient.so.0']
while pending:
    name = pending.pop()
    if name in system or name in used:
        continue
    if name not in libraries:
        raise SystemExit('Samba needs an unbundled dependency: ' + name)
    used.add(name)
    pending.extend(libraries[name]['needed'])

for name in sorted(used):
    target = lib / name
    shutil.copy2(libraries[name]['path'].resolve(), target)
    subprocess.run(['patchelf', '--set-soname', name, '--set-rpath', '$ORIGIN', str(target)], check=True)
    exports = subprocess.check_output(['nm', '--dynamic', '--defined-only', str(target)], text=True)
    names = {line.split()[-1].split('@')[0] for line in exports.splitlines() if line.split()}
    leaked = private_crypto & names
    if leaked:
        raise SystemExit(name + ' exposes private crypto symbols: ' + ', '.join(sorted(leaked)))
print('Installed', len(used), 'Samba client libraries; only glibc dependencies remain external', flush=True)
(lib / 'libsmbclient.so').symlink_to('libsmbclient.so.0')
(deps / 'include').mkdir(parents=True, exist_ok=True)
shutil.copy2('source3/include/libsmbclient.h', deps / 'include')

notices = set()
for path in Path('third_party/ngtcp2/lib').rglob('*'):
    if path.suffix not in ('.c', '.h'):
        continue
    block = re.match(r'/\*.*?\*/', path.read_text(), re.S)
    if block and 'Copyright' in block[0]:
        notices.add(block[0])
if not notices:
    raise SystemExit('No ngtcp2 copyright notices found')
Path('FFB-NGTCP2-NOTICES.txt').write_text('\n\n'.join(sorted(notices)) + '\n')
