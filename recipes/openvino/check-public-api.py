import os
from pathlib import Path
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET

deps = Path(sys.argv[1])
environment = dict(os.environ, LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1')
for name in ['OV_FRONTEND_PATH', 'OPENVINO_LIB_PATH', 'OPENVINO_PLUGIN_PATH']:
    environment.pop(name, None)
model = Path.cwd() / 'ffb-relu.xml'
model.write_text(Path(os.environ['RECIPES'], 'openvino/public-model.xml').read_text())
output = Path.cwd() / 'ffb-sdk'
compile_environment = dict(os.environ)
compile_environment.pop('LD_LIBRARY_PATH', None)
compile_environment['PKG_CONFIG_LIBDIR'] = str(deps / 'lib/pkgconfig')
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', '--static', 'openvino'],
                                          text=True, env=compile_environment))
subprocess.run([*shlex.split(os.environ.get('CC', 'gcc')),
                str(Path(os.environ['RECIPES'], 'openvino/public-api.c')),
                *flags, '-o', str(output)], check=True, env=compile_environment)
subprocess.run([str(output), str(model)], timeout=120, check=True, env=environment)
bridges = Path.cwd() / 'ffb-bridges'
subprocess.run([*shlex.split(os.environ.get('CXX', 'g++')), '-std=c++17',
                str(Path(os.environ['RECIPES'], 'openvino/public-bridges.cpp')),
                '-I' + str(Path.cwd() / 'src/core/include'), '-L' + str(deps / 'lib'), '-lopenvino',
                '-static-libstdc++', '-shared-libgcc', '-pthread', '-o', str(bridges)], check=True, env=environment)
subprocess.run([str(bridges)], timeout=30, check=True, env=environment)
required_bridges = {'_ZNKSt4hashIN2ov16DiscreteTypeInfoEEclERKS1_', '_ZSt5isnanN2ov7float16E'}
symbols = subprocess.check_output(['nm', '-D', '--defined-only', str(deps / 'lib/libopenvino.so')], text=True)
names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
assert required_bridges <= names, required_bridges - names
assert {'__cxa_get_globals', '__cxa_throw'} <= names, names
for mode, flags in [('dynamic', []), ('static', ['-static-libstdc++', '-shared-libgcc'])]:
    probe = str(bridges) + '-exception-' + mode
    subprocess.run([*shlex.split(os.environ.get('CXX', 'g++')), '-std=c++17',
                    str(Path(os.environ['RECIPES'], 'openvino/public-exception.cpp')),
                    '-I' + str(Path.cwd() / 'src/core/include'),
                    '-L' + str(deps / 'lib'), '-lopenvino', *flags, '-o', probe],
                   check=True, env=compile_environment)
    subprocess.run([probe], timeout=30, check=True, env=environment)
plugins = ET.parse(deps / 'lib/plugins.xml').findall('.//plugin')
assert {plugin.attrib['name'] for plugin in plugins} == {'CPU'}, plugins
assert all(not Path(plugin.attrib['location']).is_absolute() for plugin in plugins), 'registry must relocate'
for component in ['libopenvino', 'libopenvino_c', 'libopenvino_ir_frontend']:
    library = deps / ('lib/' + component + '.so.2641')
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    assert '[' + component + '.so.2641]' in dynamic and 'libstdc++.so' not in dynamic, dynamic
plugin = deps / 'lib/libopenvino_intel_cpu_plugin.so'
assert 'libstdc++.so' not in subprocess.check_output(['readelf', '-d', str(plugin)], text=True)
print('OpenVINO: complete native C/C++/frontend/CPU module owner, native ABI and relative plugin registry passed')
