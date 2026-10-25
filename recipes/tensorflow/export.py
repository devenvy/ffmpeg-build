"""Package native TensorFlow link inputs without modifying their bytes or symbols."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ALLOWED_FLAGS = {'-ldl', '-lm', '-lpthread', '-pthread', '-lrt'}

def install(source, deps, shared=False):
    if shared:
        install_shared(source, deps)
        return
    rows = json.loads((source / '.ffb_inputs/native-link-closure.json').read_text())
    archives = {}
    for row in rows:
        if set(row['flags']) - ALLOWED_FLAGS:
            raise SystemExit('Review new TensorFlow link flags: ' + str(row['flags']))
        if row.get('additional_inputs'):
            raise SystemExit('Review additional native TensorFlow linker inputs: ' + repr(row['additional_inputs']))
        for item in row['libraries']:
            if not item['archive']:
                raise SystemExit('Review non-archive TensorFlow static link input')
            archives[item['archive']] = archives.get(item['archive'], False) or item['alwayslink']
    if not archives or not any(archives.values()):
        raise SystemExit('TensorFlow static registration closure is missing')
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    regular = []
    arguments = ['-Wl,--start-group']
    for path, always in archives.items():
        name = 'libffb_tensorflow_' + hashlib.sha256(path.encode()).hexdigest()[:20] + '.a'
        shutil.copy2(source / path, lib / name)
        if always:
            arguments.extend(['-Wl,--whole-archive', '-l:' + name, '-Wl,--no-whole-archive'])
        else:
            regular.append('-l:' + name)
            arguments.append('-l:' + name)
    if not regular:
        raise SystemExit('Review empty native TensorFlow ordinary archive closure')
    flags = list(dict.fromkeys(flag for row in rows for flag in row['flags']))
    arguments.extend(['-l:libstdc++.a', '-l:libgcc.a', '-l:libgcc_eh.a',
                      *flags, '-lm', '-ldl', '-lpthread', '-lrt', '-Wl,--end-group'])
    # FFmpeg probes plain -ltensorflow. Only ordinary archives appear here: native
    # alwayslink archives occur once in the response file, avoiding duplicate objects.
    (lib / 'libtensorflow.a').write_text('GROUP (\n' + '\n'.join(regular) + '\n)\n')
    (lib / 'ffb-tensorflow-static.rsp').write_text(shlex.join(arguments) + '\n')

    # Capture the transitive C API headers with the target C compiler. Do not
    # install the C++ SDK or depend on private Bazel include paths at FFmpeg link time.
    external = source / ('bazel-' + source.name) / 'external'
    roots = [source, external / 'xla', external / 'tsl']
    probe = source / '_ffb-c-api.c'
    headers = ['tensorflow/c/c_api.h', 'tensorflow/c/c_api_experimental.h',
               'tensorflow/c/eager/c_api.h', 'tensorflow/c/eager/c_api_experimental.h']
    probe.write_text(''.join('#include <' + name + '>\n' for name in headers))
    dependencies = source / '_ffb-c-api.d'
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + ['-MM', '-MF', str(dependencies),
                   '-MT', 'c_api', *['-I' + str(root) for root in roots], str(probe)], check=True)
    words = shlex.split(dependencies.read_text().replace('\\\n', ' '))[1:]
    for word in words:
        header = Path(word)
        if header.suffix != '.h':
            continue
        for root in sorted(roots, key=lambda path: len(str(path)), reverse=True):
            try:
                relative = header.relative_to(root)
            except ValueError:
                continue
            destination = deps / 'include' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(header, destination)
            break
        else:
            raise SystemExit('Review unexpected TensorFlow C API header: ' + str(header))
    inventory = deps / 'share/ffmpeg-build/tensorflow-static-closure.json'
    inventory.parent.mkdir(parents=True, exist_ok=True)
    inventory.write_text(json.dumps(rows, indent=2) + '\n')

def install_shared(source, deps):
    inventory = source / '.ffb_inputs/native-link-closure.json'
    rows = json.loads(inventory.read_text())
    if not rows or not any(row['libraries'] for row in rows):
        raise SystemExit('Native TensorFlow shared closure inventory is empty')
    subprocess.run([sys.executable, str(Path(__file__).with_name('native-link.py')), str(source)], check=True)
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / 'bazel-bin/tensorflow/libtensorflow.so.2.21.0', lib / 'libtensorflow.so.2.21.0')
    (lib / 'libtensorflow.so.2').symlink_to('libtensorflow.so.2.21.0')
    (lib / 'libtensorflow.so').symlink_to('libtensorflow.so.2')
    external = source / ('bazel-' + source.name) / 'external'
    roots = [source, external / 'xla', external / 'tsl']
    probe = source / '_ffb-shared-c-api.c'
    headers = ['tensorflow/c/c_api.h', 'tensorflow/c/c_api_experimental.h',
               'tensorflow/c/eager/c_api.h', 'tensorflow/c/eager/c_api_experimental.h']
    probe.write_text(''.join('#include <' + name + '>\n' for name in headers))
    dependencies = source / '_ffb-shared-c-api.d'
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + ['-MM', '-MF', str(dependencies),
                   '-MT', 'c_api', *['-I' + str(root) for root in roots], str(probe)], check=True)
    for word in shlex.split(dependencies.read_text().replace('\\\n', ' '))[1:]:
        header = Path(word)
        if header.suffix != '.h':
            continue
        for root in sorted(roots, key=lambda path: len(str(path)), reverse=True):
            try:
                relative = header.relative_to(root)
            except ValueError:
                continue
            destination = deps / 'include' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(header, destination)
            break
        else:
            raise SystemExit('Review unexpected native TensorFlow C/eager header: ' + str(header))
    destination = deps / 'share/ffmpeg-build/tensorflow-shared-closure.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(rows, indent=2) + '\n')

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: export.py <install-prefix>')
    source = Path(__file__).resolve().parent.parent
    mode = source / '.ffb_inputs/build-mode.txt'
    install(source, Path(sys.argv[1]).resolve(), mode.exists() and mode.read_text().strip() == 'shared')
