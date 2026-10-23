"""Build the CPU C API with its native static closure or shared plugin owner."""
import os
from pathlib import Path
import re
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
    private_map = src / 'ffb-private-cxx.map'
    # These two explicitly public std specializations bridge the root and IR frontend.
    private_map.write_text('{ global: _ZNKSt4hashIN2ov16DiscreteTypeInfoEEclERKS1_; _ZSt5isnanN2ov7float16E; *; local: _ZSt*; _ZNSt*; _ZNKSt*; _ZTVSt*; _ZTISt*; _ZTSSt*; _ZTVNSt*; _ZTINSt*; _ZTSNSt*; };\n')
    private_flags = '-static-libstdc++ -shared-libgcc -pthread -Wl,-z,defs -Wl,--version-script=' + str(private_map)
    shared_args = ['-DENABLE_PLUGINS_XML=ON', '-DCMAKE_SHARED_LINKER_FLAGS=' + private_flags,
                   '-DCMAKE_MODULE_LINKER_FLAGS=' + private_flags]
run(['cmake', '-S', src, '-B', build, '-G', 'Ninja',
     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
     '-DBUILD_SHARED_LIBS=' + ('ON' if shared else 'OFF'), '-DTHREADING=SEQ', '-DENABLE_INTEL_CPU=ON',
     '-DENABLE_OV_IR_FRONTEND=ON'] + ['-D' + name + '=OFF' for name in off] + shared_args)
# Building this target also builds its runtime/plugin/frontend dependencies,
# while excluding upstream's documentation executables and sample extensions.
targets = ['openvino_c', 'openvino_intel_cpu_plugin', 'openvino_ir_frontend'] if shared else ['openvino_c']
run(['cmake', '--build', build, '--target', *targets, '--parallel', os.environ['JOBS']])
if shared:
    runtime = list((src / 'bin').rglob('libopenvino*.so*'))
    expected = {'libopenvino', 'libopenvino_c', 'libopenvino_ir_frontend', 'libopenvino_intel_cpu_plugin'}
    actual = {path.name.split('.so')[0] for path in runtime}
    if actual != expected:
        raise SystemExit('Review complete native OpenVINO CPU runtime inventory: ' + repr(actual))
    lib = deps / 'lib'
    lib.mkdir(parents=True, exist_ok=True)
    for path in runtime:
        shutil.copy2(path, lib / path.name, follow_symlinks=False)
    configurations = list((src / 'bin').rglob('plugins.xml'))
    if len(configurations) != 1:
        raise SystemExit('Expected one native CPU plugin registry: ' + repr(configurations))
    shutil.copy2(configurations[0], lib / 'plugins.xml')
    shutil.copytree(src / 'src/bindings/c/include/openvino', deps / 'include/openvino', dirs_exist_ok=True)
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
