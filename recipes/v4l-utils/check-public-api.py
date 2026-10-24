"""Exercise relocated native libraries and the upstream fixed helper-path contract."""
import os
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile

deps = Path(sys.argv[1])
cc = shlex.split(sys.argv[2])
shared = len(sys.argv) > 3 and sys.argv[3] == 'yes'
recipe = Path(os.environ['RECIPES']) / 'v4l-utils'
lib = deps / 'lib'
components = ['libv4l1', 'libv4l2', 'libv4lconvert', 'libv4l2rds']
actual = {path.name.split('.so')[0] for path in lib.glob('libv4l*.so*')}
if actual != (set(components) if shared else set()):
    raise SystemExit('Review the complete native V4L runtime inventory: ' + repr(actual))
if not shared and any(not (lib / (name + '.a')).is_file() for name in components):
    raise SystemExit('Missing native static V4L archive')
for name in ['ov511-decomp', 'ov518-decomp']:
    native = lib / 'libv4l' / name
    if not native.is_file():
        raise SystemExit('Missing native independent decoder: ' + str(native))
# Exercise the source-built programs directly without installing anything globally.
fixtures = [
    ('ov511-decomp', 32, 16, 768, 'ffffffffffffffff40400000400000400000400000400000400000400000400000400000400000400000400000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
    ('ov518-decomp', 16, 8, 192, 'ffffffffffffffff28a0028affffffff01010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101'),
]
for name, width, height, size, hexadecimal in fixtures:
    payload = bytes.fromhex(hexadecimal)
    packet = struct.pack('<iiii', width, height, 0, len(payload)) + payload
    response = struct.pack('<i', size) + bytes([128]) * size
    decoded = subprocess.run([str(lib / 'libv4l' / name)], input=packet * 2,
                             capture_output=True, timeout=30)
    if decoded.returncode != 0 or decoded.stderr or decoded.stdout != response * 2:
        raise SystemExit('Native decoder framing/EOF failed: ' + name + ': ' + repr(decoded))
sdk = Path('ffb-sdk')
sdk.mkdir(exist_ok=True)
compile_environment = dict(os.environ)
for name in ['LD_LIBRARY_PATH', 'LIBRARY_PATH']:
    compile_environment.pop(name, None)
owner = sdk / ('v4l-api' if shared else 'libffb-v4l-owner.so')
owner_flags = [] if shared else ['-shared', '-fPIC', '-Wl,-z,defs', '-Wl,--exclude-libs,ALL']
subprocess.run(cc + ['-O2', '-UNDEBUG'] + owner_flags + [str(recipe / 'public-api.c'),
                    '-I' + str(deps / 'include'), '-L' + str(lib),
                    '-lv4l1', '-lv4l2', '-lv4lconvert', '-lv4l2rds',
                    '-lm', '-lrt', '-ldl', '-o', str(owner)], check=True, env=compile_environment)
if not shared:
    subprocess.run(cc + ['-O2', '-UNDEBUG', str(recipe / 'public-loader.c'),
                         '-ldl', '-o', str(sdk / 'v4l-api')], check=True, env=compile_environment)
with tempfile.TemporaryDirectory(prefix='ffb-v4l-relocated-') as temporary:
    relocated = Path(temporary)
    for component in components:
        for source in lib.glob(component + '.so*'):
            shutil.copy2(source, relocated / source.name, follow_symlinks=False)
    arguments = [str((sdk / 'v4l-api').resolve())]
    if not shared:
        shutil.copy2(owner, relocated / owner.name)
        arguments.append(str(relocated / owner.name))
    environment = dict(compile_environment, LD_LIBRARY_PATH=str(relocated), LD_BIND_NOW='1')
    for suffix in ['511', '518']:
        environment['FFB_V4L_OV' + suffix] = '1' if os.access('/usr/lib/libv4l/ov' + suffix + '-decomp', os.X_OK) else '0'
    subprocess.run(arguments, check=True, timeout=30,
                   env=environment, cwd='/')
if shared:
    for component in components:
        dynamic = subprocess.check_output(['readelf', '-d', str(lib / (component + '.so.0'))], text=True)
        if '[' + component + '.so.0]' not in dynamic:
            raise SystemExit('Native V4L ABI changed: ' + component)
print('V4L: native decoder bytes/EOF, relocated software conversion and fixed system-helper contract passed')
