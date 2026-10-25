"""Source-built CPU TorchScript, with recorded generator dependencies."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

src = Path.cwd()
deps = Path(os.environ['DEPS_DIR'])
shared = len(sys.argv) > 1 and sys.argv[1] == 'shared'
if os.environ['VERSION'] != '2.7.1':
    raise SystemExit('Review the Torch CPU dependency inventory before changing versions')

def run(args, cwd=None, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)

submodules = {
    'pybind11': 'a2e59f0e7065404b44dfe92a28aca47ba1378dc4',
    'protobuf': 'd1eca4e4b421cd2997495c4b4e65cea6be4e9b8a',
    'cpuinfo': '1e83a2fdd3102f65c6f1fb602c1b320486218a99',
    'pthreadpool': '4fe0e1e183925bf8cfa6aae24237e724a96479b8',
    'FP16': '4dfe081cf6bcd15db339cf2680b9281b8451eeb3',
    'psimd': '072586a71b55b7f8c584153d223e95687148a900',
    'sleef': '56e1f79cb140fb9326d612d0be06b5250565cade',
    'fmt': '123913715afeb8a437e6388b4473fcc4753e1c9a',
    'pocketfft': '9d3ab05a7fffbc71a492bc6a17be034e83e8f0fe',
    'flatbuffers': '01834de25e4bf3975a9a00e816292b1ad0fe184b',
    'nlohmann': '87cda1d6646592ac5866dc703c8e1839046a6806',
    'kineto': 'a054a4be0db117c579a21747debf19c863631f26',
    'onnx': 'b8baa8446686496da4cc8fda09f2b6fe65c2a02c',
    'eigen': '3147391d946bb4b6c68edd901f2add6ac1f31f8c',
}
run(['git', 'submodule', 'update', '--init', '--recursive', '--depth', '1', '--jobs', '4'])
for name, commit in submodules.items():
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=src / 'third_party' / name, text=True).strip()
    if actual != commit:
        raise SystemExit('Torch submodule mismatch: ' + name)
python_sources = [
    ('pyyaml', 'yaml/pyyaml', '49790e73684bebad1df05ef8d828fa12f685bffb', 'lib'),
    ('typing_extensions', 'python/typing_extensions', '9d1637e264b5c1a6b7acee3e907015f89b20c2c9', 'src'),
    ('sympy', 'sympy/sympy', '16fa855354eb7bcabd3fe10993841e03b1382692', '.'),
    ('mpmath', 'mpmath/mpmath', 'b5c04506ef0cd4a1f1213f8389ee21c9c3551582', '.'),
    ('packaging', 'pypa/packaging', 'f58537628042c7f29780b9d33f31597e7fc9d664', 'src'),
]
paths = [str(src)]
for name, repo, commit, module in python_sources:
    dest = src / 'third_party/ffb_python' / name
    if not (dest / '.git').exists():
        run(['git', 'init', '-q', dest])
        run(['git', 'fetch', '--depth', '1', 'https://github.com/' + repo + '.git', commit], dest)
        run(['git', 'checkout', '--detach', 'FETCH_HEAD'], dest)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=dest, text=True).strip()
    if actual != commit:
        raise SystemExit('Torch generator source mismatch: ' + name)
    paths.append(str(dest / module))
venv = src / '_python'
run(['python3', '-m', 'venv', '--without-pip', venv])
python = venv / 'bin/python'
env = dict(os.environ, PYTHONPATH=':'.join(paths))
build = src / '_build'
install = src / '_install'
off = ['BUILD_SHARED_LIBS', 'BUILD_PYTHON', 'BUILD_TEST', 'BUILD_BINARY', 'USE_CUDA',
       'USE_ROCM', 'USE_XPU', 'USE_DISTRIBUTED', 'USE_KINETO', 'USE_OPENMP',
       'USE_NNPACK', 'USE_PYTORCH_QNNPACK', 'USE_XNNPACK', 'USE_FBGEMM',
       'USE_MKLDNN', 'USE_NUMPY', 'USE_ITT', 'USE_MIMALLOC', 'USE_MPI',
       'USE_TENSORPIPE', 'USE_KLEIDIAI']
shared_args = []
if shared:
    off.remove('BUILD_SHARED_LIBS')
    shared_args = ['-DBUILD_SHARED_LIBS=ON', '-DHAVE_SOVERSION=ON',
                   '-DCMAKE_SHARED_LINKER_FLAGS=-shared-libgcc -pthread -Wl,-z,defs']
run(['cmake', '-S', src, '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DCMAKE_INSTALL_PREFIX=' + str(install), '-DBLAS=Eigen',
     '-DGLIBCXX_USE_CXX11_ABI=1', '-DTORCH_BUILD_VERSION=2.7.1',
     '-DCMAKE_DISABLE_FIND_PACKAGE_BLAS=ON',
     '-DPython_EXECUTABLE=' + str(python), '-DINTERN_DISABLE_ONNX=OFF',
     '-DCAFFE2_LINK_LOCAL_PROTOBUF=' + ('ON' if shared else 'OFF'), '-DBUILD_CUSTOM_PROTOBUF=ON'] +
    ['-D' + name + '=OFF' for name in off] + shared_args, env=env)
run(['cmake', '--build', build, '--parallel', os.environ['JOBS']], env=env)
run(['cmake', '--install', build], env=env)
if not shared:
    # TorchConfig searches these native names, but the top-level static install
    # omits the ONNX archives built by its own dependency targets.
    for name in ['libonnx.a', 'libonnx_proto.a']:
        shutil.copy2(build / 'lib' / name, install / 'lib' / name)
# Preserve native archive names, SDK headers and CMake exports together.
shutil.copytree(install, deps, dirs_exist_ok=True, symlinks=True)
if shared:
    # Preserve every native CPU DSO; fail if this reviewed inventory changes.
    runtime = list((install / 'lib').glob('*.so*'))
    components = {path.name.split('.so')[0] for path in runtime}
    expected = {'libtorch', 'libtorch_cpu', 'libc10', 'libtorch_global_deps'}
    if components != expected:
        raise SystemExit('Review complete native Torch CPU runtime inventory: ' + repr(components))
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    pc = lib / 'pkgconfig'
    pc.mkdir(exist_ok=True)
    (pc / 'torch.pc').write_text('prefix=' + str(deps) + '''
Name: torch
Description: Native shared CPU TorchScript runtime
Version: 2.7.1
Cflags: -I${prefix}/include -I${prefix}/include/torch/csrc/api/include -std=c++17 -D_GLIBCXX_USE_CXX11_ABI=1
Libs: -L${prefix}/lib -ltorch -ltorch_cpu -lc10
Libs.private: -lstdc++ -lm -ldl -lpthread
''')
    run([sys.executable, Path(os.environ['RECIPES']) / 'torch/check-public-api.py', deps, 'shared'])
    sys.exit(0)
inventory = src / '_ffb_inventory'
inventory.mkdir(exist_ok=True)
(inventory / 'main.cpp').write_text('int main() { return 0; }\n')
(inventory / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(ffb_inventory LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(Torch REQUIRED CONFIG NO_DEFAULT_PATH PATHS "${TORCH_PREFIX}/share/cmake/Torch")
add_executable(ffb_torch_inventory main.cpp)
target_link_libraries(ffb_torch_inventory PRIVATE "${TORCH_LIBRARIES}")
''')
run(['cmake', '-S', inventory, '-B', inventory / 'build', '-G', 'Unix Makefiles',
     '-DTORCH_PREFIX=' + str(install)])
tokens = shlex.split((inventory / 'build/CMakeFiles/ffb_torch_inventory.dir/link.txt').read_text())
tokens = tokens[tokens.index('ffb_torch_inventory') + 1:]
lib = deps / 'lib'
lib.mkdir(parents=True, exist_ok=True)
libs = []
whole = False
for token in tokens + [str(build / 'lib/libonnx.a'), str(build / 'lib/libonnx_proto.a')]:
    if token == '-Wl,--whole-archive':
        whole = True
        libs.append(token)
    elif token == '-Wl,--no-whole-archive':
        whole = False
        libs.append(token)
    elif token.endswith('.a'):
        path = Path(token)
        relative = path.resolve().relative_to(src.resolve())
        name = 'libffb_torch_' + '_'.join(relative.parts)
        shutil.copy2(path, lib / name)
        libs.append('-l:' + name)
    elif token.startswith('-l') or token == '-pthread':
        libs.append(token)
if whole or not libs:
    raise SystemExit('Incomplete Torch static CMake closure')
closure = ['-Wl,--as-needed', '-Wl,--start-group', *libs,
           '-l:libstdc++.a', '-l:libgcc.a', '-l:libgcc_eh.a',
           '-lm', '-ldl', '-lpthread', '-lrt', '-Wl,--end-group']
(lib / 'ffb-torch-static.rsp').write_text(shlex.join(closure) + '\n')
pc = lib / 'pkgconfig'
pc.mkdir(exist_ok=True)
(pc / 'torch.pc').write_text('prefix=' + str(deps) + '''
Name: torch
Description: Static CPU TorchScript runtime
Version: 2.7.1
Cflags: -I${prefix}/include -I${prefix}/include/torch/csrc/api/include -std=c++17 -D_GLIBCXX_USE_CXX11_ABI=1
Libs: -L${prefix}/lib ''' + shlex.join(closure) + '\n')
run([sys.executable, Path(os.environ['RECIPES']) / 'torch/check-public-api.py', deps, 'static'])
