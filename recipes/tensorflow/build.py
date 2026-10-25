"""Build the pinned TensorFlow C API using only prefilled, verified Bazel inputs."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

source = Path.cwd()
recipe = Path(os.environ['RECIPES']) / 'tensorflow'
deps = Path(os.environ['DEPS_DIR'])
inputs = source / '.ffb_inputs'
inputs.mkdir(exist_ok=True)
pins = json.loads((recipe / 'inputs.json').read_text())
shared = len(sys.argv) > 1 and sys.argv[1] == 'shared'
(inputs / 'build-mode.txt').write_text('shared\n' if shared else 'static\n')
if os.environ['VERSION'] != pins['tensorflow']:
    raise SystemExit('Review TensorFlow inputs and runtime notices before changing versions')

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def run(args, cwd=source):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)

def module(name):
    spec = importlib.util.spec_from_file_location('ffb_tf_' + name, recipe / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

def download(entry):
    target = source / entry['path']
    if target.exists() and digest(target) == entry['sha256']:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    urls = entry.get('mirrors', []) + [entry['origin']]
    if urls[0].startswith('http://'):
        urls.insert(0, 'https://' + urls[0].removeprefix('http://'))
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        fetched = Path(temporary) / 'input'
        for url in urls:
            result = subprocess.run(['curl', '--fail', '--location', '--retry', '3',
                                     '--output', str(fetched), url])
            if result.returncode == 0 and digest(fetched) == entry['sha256']:
                break
            print('Rejected failed or checksum-mismatched input from ' + url, flush=True)
        else:
            raise SystemExit('Cannot fetch checksum-verified TensorFlow input: ' + entry['repository'])
        shutil.copy2(fetched, target)

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download, pins['files']))
for marker in pins['cacheIds']:
    path = source / marker
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'')
(inputs / 'bazel-7.7.0').chmod(0o755)
go = inputs / 'go-sdk'
go.mkdir(exist_ok=True)
go_pin = next(entry for entry in pins['files'] if entry['repository'] == 'go-sdk-build-tool')
run(['tar', '-xf', source / go_pin['path'], '-C', go, '--strip-components=1'])
shutil.copy2(recipe / 'go-sdk/BUILD.bazel', go / 'BUILD.bazel')
for name in ['ROOT', 'REPO.bazel']:
    (go / name).write_bytes(b'')

llvm = source / 'third_party/ffb_llvm'
if not (llvm / '.git').exists():
    run(['git', 'init', '-q', llvm])
    run(['git', 'fetch', '--depth', '1', 'https://github.com/llvm/llvm-project.git', pins['llvmCommit']], llvm)
    run(['git', 'checkout', '--detach', 'FETCH_HEAD'], llvm)
actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=llvm, text=True).strip()
if actual != pins['llvmCommit']:
    raise SystemExit('TensorFlow LLVM source commit mismatch')

custom = source / 'ffb'
custom.mkdir(exist_ok=True)
for name in ['BUILD.bazel', 'link.bzl']:
    shutil.copy2(recipe / 'ffb' / name, custom / name)
for name in ['inputs.json', 'replay.py', 'restore.py', 'build.py', 'export.py', 'native-link.py', 'notices.py',
             'validate.c', 'validate-eager.c', 'public-headers.cpp', 'check-public-api.py', 'OOURA-PERMISSION.txt', 'README.md']:
    shutil.copy2(recipe / name, inputs / name)
module('replay').build(source, shared)
module('export').install(source, deps, shared)
consumer = source / '_ffb-c-api-check'
run(shlex.split(os.environ.get('CC', 'cc')) + ['-I' + str(deps / 'include'),
    recipe / 'validate.c', '-L' + str(deps / 'lib'), '-ltensorflow',
    *([] if shared else ['@' + str(deps / 'lib/ffb-tensorflow-static.rsp')]), '-o', consumer])
runtime_environment = dict(os.environ, LD_LIBRARY_PATH=str(deps / 'lib'),
                           TF_NUM_INTRAOP_THREADS='2', TF_NUM_INTEROP_THREADS='2')
subprocess.run([str(consumer), str(inputs / 'authored-relu.pb')], check=True, env=runtime_environment)
run([sys.executable, recipe / 'check-public-api.py', deps, 'shared' if shared else 'static'])
module('notices').collect(source, pins, shared)

# Mirror choices belong to the preserved recipe input catalog. The engine inventory records
# the canonical origin and verified bytes using its strict, versioned source-record fields.
records = [{key: entry[key] for key in ['path', 'sha256', 'origin', 'kind', 'repository', 'filename']}
           for entry in pins['files']]
known = {entry['path'] for entry in records}
metadata = [source / path for path in pins['cacheIds']]
metadata += [custom / 'BUILD.bazel', custom / 'link.bzl']
if shared:
    metadata += [inputs / 'native-shared-link.json']
metadata += [go / name for name in ['BUILD.bazel', 'ROOT', 'REPO.bazel']]
metadata += [inputs / name for name in ['inputs.json', 'replay.py', 'build.py', 'export.py', 'native-link.py',
                                     'restore.py', 'notices.py', 'validate.c', 'validate-eager.c',
                                     'public-headers.cpp', 'check-public-api.py', 'build-mode.txt', 'OOURA-PERMISSION.txt', 'README.md',
                                     'resolved-current.bzl', 'authored-relu.pb']]
metadata += [inputs / 'native-link-closure.json']
metadata += [inputs / name for name in module('replay').PATCHES]
for path in metadata:
    relative = str(path.relative_to(source))
    if relative in known:
        continue
    records.append({'path': relative, 'sha256': digest(path),
                    'origin': 'recipe-generated:tensorflow-replay-metadata',
                    'repository': 'tensorflow-replay', 'filename': path.name, 'kind': 'metadata'})
    known.add(relative)
(source / 'ffb-source-inputs.json').write_text(json.dumps({'version': 1, 'files': records}, indent=2) + '\n')
