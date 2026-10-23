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
if os.environ['VERSION'] != '2.14.1':
    raise SystemExit('Review the Torch CPU dependency inventory before changing versions')

def run(args, cwd=None, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)

submodules = {
    'pybind11': '97bf890db679505a14dfe547a5e77bb2bd05dc90',
    'protobuf': 'f0dc78d7e6e331b8c6bb2d5283e06aa26883ca7c',
    'cpuinfo': 'bc3c01e230c6974283e4b89421cfb0e232435589',
    'pthreadpool': 'a56dcd79c699366e7ac6466792c3025883ff7704',
    'FP16': '4dfe081cf6bcd15db339cf2680b9281b8451eeb3',
    'psimd': '072586a71b55b7f8c584153d223e95687148a900',
    'sleef': '5a1d179df9cf652951b59010a2d2075372d67f68',
    'fmt': 'c0330b746600bfd91dbacb88837da5a16f947ba5',
    'pocketfft': '0fa0ef591e38c2758e3184c6c23e497b9f732ffa',
    'flatbuffers': 'a2cd1ea3b6d3fee220106b5fed3f7ce8da9eb757',
    'nlohmann': '55f93686c01528224f448c19128836e7df245f72',
    'kineto': '15f4784a3471d4db8b31720d528f2f57cd2b1f40',
    'onnx': 'e709452ef2bbc1d113faf678c24e6d3467696e83',
}
run(['git', 'submodule', 'update', '--init', '--depth', '1', '--jobs', '4', '--'] +
    ['third_party/' + name for name in submodules])
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
prebuild = src / 'cmake/PreBuildSteps.cmake'
text = prebuild.read_text()
check = 'if(NOT DEFINED USE_SYSTEM_LIBS OR NOT USE_SYSTEM_LIBS)'
replacement = 'if(FALSE) # FFB: the selected CPU submodules were fetched above'
if check not in text and replacement not in text:
    raise SystemExit('Torch submodule-presence check changed upstream')
prebuild.write_text(text.replace(check, replacement, 1))
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
    private_map = src / 'ffb-private-cxx.map'
    # These explicitly public std overloads print native tensor-expression SDK objects.
    bridges = ['_ZSt9to_stringB5cxx11RKN5torch3jit10tensorexpr6TensorE',
               '_ZSt9to_stringB5cxx11RKSt10shared_ptrIN5torch3jit10tensorexpr4ExprEE',
               '_ZSt9to_stringB5cxx11RKSt10shared_ptrIN5torch3jit10tensorexpr4StmtEE']
    private_map.write_text('{ global: ' + '; '.join(bridges) + '; *; local: _ZSt*; _ZNSt*; _ZNKSt*; _ZTVSt*; _ZTISt*; _ZTSSt*; _ZTVNSt*; _ZTINSt*; _ZTSNSt*; *6google8protobuf*; };\n')
    shared_args = ['-DBUILD_SHARED_LIBS=ON', '-DHAVE_SOVERSION=ON',
                   '-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -shared-libgcc -pthread -Wl,-z,defs -Wl,--version-script=' + str(private_map)]
run(['cmake', '-S', src, '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DCMAKE_INSTALL_PREFIX=' + str(install), '-DBLAS=Eigen',
     '-DPython_EXECUTABLE=' + str(python), '-DINTERN_DISABLE_ONNX=OFF',
     '-DCAFFE2_LINK_LOCAL_PROTOBUF=' + ('ON' if shared else 'OFF'), '-DBUILD_CUSTOM_PROTOBUF=ON'] +
    ['-D' + name + '=OFF' for name in off] + shared_args, env=env)
run(['cmake', '--build', build, '--parallel', os.environ['JOBS']], env=env)
run(['cmake', '--install', build], env=env)
if shared:
    # Preserve every native CPU DSO; fail if this reviewed inventory changes.
    runtime = list((install / 'lib').glob('*.so*'))
    components = {path.name.split('.so')[0] for path in runtime}
    expected = {'libtorch', 'libtorch_cpu', 'libc10', 'libtorch_global_deps'}
    if components != expected:
        raise SystemExit('Review complete native Torch CPU runtime inventory: ' + repr(components))
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    for path in runtime:
        shutil.copy2(path, lib / path.name, follow_symlinks=False)
    shutil.copytree(install / 'include', deps / 'include', dirs_exist_ok=True)
    pc = lib / 'pkgconfig'
    pc.mkdir(exist_ok=True)
    (pc / 'torch.pc').write_text('prefix=' + str(deps) + '''
Name: torch
Description: Native shared CPU TorchScript runtime
Version: 2.14.1
Cflags: -I${prefix}/include -I${prefix}/include/torch/csrc/api/include -std=c++20
Libs: -L${prefix}/lib -ltorch -ltorch_cpu -lc10
Libs.private: -l:libstdc++.a -lm -ldl -lpthread
''')
    run([sys.executable, Path(os.environ['RECIPES']) / 'torch/check-public-api.py', deps])
    sys.exit(0)
inventory = src / '_ffb_inventory'
inventory.mkdir(exist_ok=True)
(inventory / 'main.cpp').write_text('int main() { return 0; }\n')
(inventory / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(ffb_inventory LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
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
copied = []
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
        copied.append(lib / name)
        libs.append('-l:' + name)
    elif token.startswith('-l') or token == '-pthread':
        libs.append(token)
if whole or not libs:
    raise SystemExit('Incomplete Torch static CMake closure')
run([sys.executable, Path(os.environ['RECIPES']) / 'torch/isolate-protobuf.py',
     deps / 'share/ffmpeg-build/torch-protobuf-symbols.map', *dict.fromkeys(copied)])
shutil.copytree(install / 'include', deps / 'include', dirs_exist_ok=True)
pc = lib / 'pkgconfig'
pc.mkdir(exist_ok=True)
(pc / 'torch.pc').write_text('prefix=' + str(deps) + '''
Name: torch
Description: Static CPU TorchScript runtime
Version: 2.14.1
Cflags: -I${prefix}/include -I${prefix}/include/torch/csrc/api/include -std=c++20
Libs: -L${prefix}/lib -Wl,--as-needed -Wl,--start-group ''' + ' '.join(libs) +
    ' -l:libstdc++.a -l:libgcc.a -l:libgcc_eh.a -lm -ldl -lpthread -lrt -Wl,--end-group\n')
