"""Build the CPU C API and package its upstream CMake static dependency closure."""
import os
from pathlib import Path
import re
import shutil
import subprocess

src = Path.cwd()
deps = Path(os.environ['DEPS_DIR'])
build = src / '_build'
inventory = src / '_ffb_inventory'

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
run(['cmake', '-S', src, '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DBUILD_SHARED_LIBS=OFF', '-DTHREADING=SEQ', '-DENABLE_INTEL_CPU=ON',
     '-DENABLE_OV_IR_FRONTEND=ON'] + ['-D' + name + '=OFF' for name in off])
# Building this target also builds its runtime/plugin/frontend dependencies,
# while excluding upstream's documentation executables and sample extensions.
run(['cmake', '--build', build, '--target', 'openvino_c', '--parallel', os.environ['JOBS']])
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
archives = list(dict.fromkeys(re.findall(r'/[^\s]+\.a', link)))
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
(lib / 'libopenvino.a').write_text('GROUP (\n' + '\n'.join(names) +
                                  '\n-l:libstdc++.a -lm -ldl -lpthread\n)\n')
shutil.copytree(src / 'src/bindings/c/include/openvino', deps / 'include/openvino',
                dirs_exist_ok=True)
