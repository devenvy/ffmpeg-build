"""Install TensorFlow's actual static closure without losing kernel registrations."""
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
    rows = json.loads((source / 'bazel-bin/ffb/c_api_static.ffb-link.json').read_text())
    archives = {}
    for row in rows:
        if set(row['flags']) - ALLOWED_FLAGS:
            raise SystemExit('Review new TensorFlow link flags: ' + str(row['flags']))
        for item in row['libraries']:
            if not item['archive']:
                raise SystemExit('Review non-archive TensorFlow static link input')
            archives[item['archive']] = archives.get(item['archive'], False) or item['alwayslink']
    if not archives or not any(archives.values()):
        raise SystemExit('TensorFlow static registration closure is missing')
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    object_file = source / '_ffb-kernels.o'
    response = source / '_ffb-kernels.rsp'
    forced = [source / path for path, always in archives.items() if always]
    args = ['-r', '--whole-archive', *map(str, forced), '--no-whole-archive', '-o', str(object_file)]
    response.write_text('\n'.join(shlex.quote(arg) for arg in args) + '\n')
    linker = source / ('bazel-' + source.name) / 'external/llvm18_linux_x86_64/bin/ld.lld'
    subprocess.run([str(linker), '@' + str(response)], check=True)
    kernel_archive = lib / 'libffb_tensorflow_kernels.a'
    subprocess.run(shlex.split(os.environ.get('AR', 'ar')) + ['rcs', str(kernel_archive), str(object_file)], check=True)
    names = [kernel_archive.name]
    for path, always in archives.items():
        if always:
            continue
        name = 'libffb_tensorflow_' + hashlib.sha256(path.encode()).hexdigest()[:20] + '.a'
        shutil.copy2(source / path, lib / name)
        names.append(name)
    mapping = deps / 'share/ffmpeg-build/tensorflow-private-symbols.map'
    subprocess.run([sys.executable, str(Path(__file__).with_name('isolate-private.py')),
                    str(mapping), *[str(lib / name) for name in names]], check=True)
    (lib / 'libtensorflow.a').write_text('GROUP (\n' + '\n'.join('-l:' + name for name in names) +
        '\n-l:libstdc++.a -l:libgcc.a -l:libgcc_eh.a -lm -ldl -lpthread -lrt\n)\n')

    # Capture the transitive C API headers with the target C compiler. Do not
    # install the C++ SDK or depend on private Bazel include paths at FFmpeg link time.
    external = source / ('bazel-' + source.name) / 'external'
    roots = [source, external / 'xla', external / 'tsl']
    probe = source / '_ffb-c-api.c'
    probe.write_text('#include <tensorflow/c/c_api.h>\n')
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
    inventory = source / 'bazel-bin/tensorflow/ffb/c_api_shared_inventory.ffb-link.json'
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
