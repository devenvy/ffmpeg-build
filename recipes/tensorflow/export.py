"""Package native TensorFlow link inputs without modifying their bytes or symbols."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

def install(source, deps, shared=True):
    if not shared:
        raise SystemExit('Static TensorFlow integration is not supported by stock shared FFmpeg builds')
    install_shared(source, deps)


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
    install(source, Path(sys.argv[1]).resolve())
