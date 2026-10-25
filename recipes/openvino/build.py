"""Build the CPU C API with its native static closure or shared plugin owner."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

src = Path.cwd()
deps = Path(os.environ['DEPS_DIR'])
build = src / '_build'
inventory = src / '_ffb_inventory'
shared = len(sys.argv) > 1 and sys.argv[1] == 'shared'

def run(args, cwd=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)

off = ['ENABLE_INTEL_GPU', 'ENABLE_INTEL_NPU', 'ENABLE_PROXY', 'ENABLE_AUTO',
       'ENABLE_MULTI', 'ENABLE_AUTO_BATCH', 'ENABLE_HETERO', 'ENABLE_TEMPLATE',
       'ENABLE_OV_ONNX_FRONTEND', 'ENABLE_OV_PADDLE_FRONTEND',
       'ENABLE_OV_PYTORCH_FRONTEND', 'ENABLE_OV_JAX_FRONTEND', 'ENABLE_OV_TF_FRONTEND',
       'ENABLE_OV_TF_LITE_FRONTEND', 'ENABLE_OV_GGUF_FRONTEND', 'ENABLE_PYTHON',
       'ENABLE_JS', 'ENABLE_SAMPLES', 'ENABLE_TESTS', 'ENABLE_DOCS',
       'ENABLE_PROFILING_ITT', 'ENABLE_PROFILING_FIRST_INFERENCE',
       'ENABLE_SYSTEM_PUGIXML', 'ENABLE_IO_URING', 'ENABLE_MLAS_FOR_CPU',
       'ENABLE_KLEIDIAI_FOR_CPU', 'CMAKE_COMPILE_WARNING_AS_ERROR']
shared_args = []
if shared:
    native_flags = '-shared-libgcc -pthread -Wl,-z,defs'
    shared_args = ['-DENABLE_PLUGINS_XML=ON', '-DCMAKE_SHARED_LINKER_FLAGS=' + native_flags,
                   '-DCMAKE_MODULE_LINKER_FLAGS=' + native_flags]
run(['cmake', '-S', src, '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DCMAKE_INSTALL_PREFIX=' + str(deps), '-DCMAKE_INSTALL_LIBDIR=lib',
     '-DCMAKE_INSTALL_INCLUDEDIR=include', '-DCPACK_GENERATOR=CONAN', '-DENABLE_PKGCONFIG_GEN=ON',
     '-DBUILD_SHARED_LIBS=' + ('ON' if shared else 'OFF'), '-DTHREADING=SEQ', '-DENABLE_INTEL_CPU=ON',
     '-DENABLE_OV_IR_FRONTEND=ON'] + ['-D' + name + '=OFF' for name in off] + shared_args)
# Building this target also builds its runtime/plugin/frontend dependencies,
# while excluding upstream's documentation executables and sample extensions.
targets = ['openvino_c', 'openvino_intel_cpu_plugin', 'openvino_ir_frontend'] if shared else ['openvino_c']
run(['cmake', '--build', build, '--target', *targets, '--parallel', os.environ['JOBS']])
# OpenVINO's native common-library layout preserves its complete headers, archives and CMake SDK.
# Components exclude samples/tools that were not built; no vendor file is rewritten.
for component in (['core', 'core_dev', 'cpu', 'ir'] if shared else ['core', 'core_dev']):
    run(['cmake', '--install', build, '--component', component])
if shared:
    lib = deps / 'lib'
    runtime = list(lib.glob('libopenvino*.so*'))
    expected = {'libopenvino', 'libopenvino_c', 'libopenvino_ir_frontend', 'libopenvino_intel_cpu_plugin'}
    actual = {path.name.split('.so')[0] for path in runtime}
    if actual != expected:
        raise SystemExit('Review complete native OpenVINO CPU runtime inventory: ' + repr(actual))
    if not (lib / 'plugins.xml').is_file():
        raise SystemExit('Native install omitted the CPU plugin registry')
    sys.exit(0)
inventory.mkdir(exist_ok=True)
(inventory / 'main.c').write_text('int main(void) { return 0; }\n')
(inventory / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(ffb_inventory LANGUAGES C CXX)
find_package(OpenVINO REQUIRED COMPONENTS Runtime CONFIG NO_DEFAULT_PATH
             PATHS "${OV_BUILD}")
add_executable(ffb_inventory main.c)
set_target_properties(ffb_inventory PROPERTIES LINKER_LANGUAGE CXX)
target_link_libraries(ffb_inventory PRIVATE openvino::runtime::c)
''')
run(['cmake', '-S', inventory, '-B', inventory / 'build', '-G', 'Unix Makefiles',
     '-DOV_BUILD=' + str(build)])
link = (inventory / 'build/CMakeFiles/ffb_inventory.dir/link.txt').read_text()
archives = list(dict.fromkeys(token for token in shlex.split(link)
                              if token.endswith('.a') and Path(token).is_absolute()))
if not archives:
    raise SystemExit('OpenVINO did not export a static dependency closure')
lib = deps / 'lib'
lib.mkdir(parents=True, exist_ok=True)
names = []
for archive in archives:
    path = Path(archive)
    # OpenVINO puts outputs under the source tree's bin/ folder as well as _build/.
    relative = path.resolve().relative_to(src.resolve())
    name = 'libffb_ov_' + '_'.join(relative.parts)
    shutil.copy2(path, lib / name)
    names.append('-l:' + name)
(lib / 'ffb-openvino-cpu.ld').write_text('GROUP (\n' + '\n'.join(names) +
                                  '\n-l:libstdc++.a -lm -ldl -lpthread\n)\n')
