"""Build the pinned CPU runtime and install its complete static link closure."""
import concurrent.futures
import os
from pathlib import Path
import shutil
import subprocess
import sys

SRC = Path.cwd()
DEPS = Path(os.environ['DEPS_DIR'])
JOBS = os.environ['JOBS']
if os.environ['VERSION'] != '1.31.0':
    raise SystemExit('Update the pinned ONNX Runtime dependency inventory before changing versions')

DEPENDENCIES = [
    ('abseil_cpp', 'abseil/abseil-cpp', '987c57f325f7fa8472fa84e1f885f7534d391b0d', []),
    ('re2', 'google/re2', '6dcd83d60f7944926bfd308cc13979fc53dd69ca', []),
    ('Protobuf', 'protocolbuffers/protobuf', '6e1998413a5bca7c058b85999667893f167434bc', [
        'protobuf/protobuf_android_log.patch', 'protobuf/protobuf_msvc_unreachable_code.patch',
        'protobuf/protobuf_msvc_map_unreachable_code.patch', 'protobuf/protobuf_compiler_incomplete_type.patch']),
    ('date', 'HowardHinnant/date', '6e921e1b1d21e84a5c82416ba7ecd98e33a436d0', ['date/date.patch']),
    ('mp11', 'boostorg/mp11', '0a0b5fb001ce0233ae3a6f99d849c0649e5a7361', []),
    ('nlohmann_json', 'nlohmann/json', '9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03', []),
    ('GSL', 'microsoft/GSL', '249146590e322123cd0b378b1f364d6069717687', ['gsl/1213.patch']),
    ('safeint', 'dcleblanc/SafeInt', '4cafc9196c4da9c817992b20f5253ef967685bf8', []),
    ('flatbuffers', 'google/flatbuffers', '0100f6a5779831fa7a651e4b67ef389a8752bd9b', ['flatbuffers/flatbuffers.patch']),
    ('onnx', 'onnx/onnx', '2bb50465112feca9003e1ed654d77f01ff1415ca', ['onnx/onnx.patch']),
    ('Eigen3', 'eigen-mirror/eigen', '1d8b82b0740839c0de7f1242a3585e3390ff5f33', [
        'eigen/s390x-build.patch', 'eigen/s390x-build-werror.patch']),
]

def run(args, cwd=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)

def fetch(dep):
    name, repo, commit, patches = dep
    dest = SRC / 'third_party' / 'ffb_deps' / name
    if not (dest / '.git').exists():
        run(['git', 'init', '-q', dest])
        run(['git', 'fetch', '--depth', '1', 'https://github.com/' + repo + '.git', commit], dest)
        run(['git', 'checkout', '--detach', 'FETCH_HEAD'], dest)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=dest, text=True).strip()
    if actual != commit:
        raise RuntimeError(name + ' source mismatch')
    for patch in patches:
        path = SRC / 'cmake' / 'patches' / patch
        reverse = subprocess.run(['git', 'apply', '--reverse', '--check', str(path)], cwd=dest,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if reverse.returncode:
            run(['git', 'apply', '--ignore-space-change', '--ignore-whitespace', path], dest)
    return '-DFETCHCONTENT_SOURCE_DIR_' + name.upper() + '=' + str(dest)

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    overrides = list(pool.map(fetch, DEPENDENCIES))

build = SRC / '_build'
run(['cmake', '-S', SRC / 'cmake', '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DCMAKE_INSTALL_PREFIX=' + str(DEPS), '-DBUILD_SHARED_LIBS=OFF',
     '-Donnxruntime_BUILD_SHARED_LIB=OFF', '-Donnxruntime_BUILD_UNIT_TESTS=OFF',
     '-Donnxruntime_BUILD_BENCHMARKS=OFF', '-Donnxruntime_ENABLE_TRAINING=OFF',
     '-Donnxruntime_ENABLE_PYTHON=OFF', '-Donnxruntime_USE_TELEMETRY=OFF',
     '-Donnxruntime_USE_CUDA=OFF', '-Donnxruntime_USE_XNNPACK=OFF',
     '-Donnxruntime_ENABLE_CPUINFO=OFF', '-Donnxruntime_MINIMAL_BUILD=OFF',
     '-Donnxruntime_COMPILE_NO_WARNING_AS_ERROR=ON', '-DFETCHCONTENT_FULLY_DISCONNECTED=ON',
     '-DFETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER', '-Dprotobuf_WITH_ZLIB=OFF',
     '-DEIGEN_MPL2_ONLY=ON'] + overrides)
# Upstream includes RE2's headers but omits its archive from the default static target closure.
run(['cmake', '--build', build, '--target', 'all', 're2', '--parallel', JOBS])
inc = DEPS / 'include'
lib = DEPS / 'lib'
inc.mkdir(parents=True, exist_ok=True)
lib.mkdir(parents=True, exist_ok=True)
archives = []
for archive in sorted(build.rglob('*.a')):
    name = 'libffb_ort_' + '_'.join(archive.relative_to(build).parts)
    target = lib / name
    shutil.copy2(archive, target)
    archives.append('-l:' + name)
if not archives:
    raise SystemExit('ONNX Runtime produced no static archives')
# GNU ld rescans the circular static graph. C++ is static to preserve the image's libc baseline.
(lib / 'libonnxruntime.a').write_text('GROUP (\n' + '\n'.join(archives) +
                                      '\n-l:libstdc++.a -lm -ldl -lpthread\n)\n')
for header in (SRC / 'include/onnxruntime/core/session').glob('*.h'):
    shutil.copy2(header, inc / header.name)
