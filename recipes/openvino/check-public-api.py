import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET

deps = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else 'shared'
if mode not in {'static', 'shared'}:
    raise SystemExit('Expected static or shared OpenVINO SDK mode')
recipe = Path(os.environ['RECIPES'], 'openvino')
environment = dict(os.environ, LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1')
for name in ['OV_FRONTEND_PATH', 'OPENVINO_LIB_PATH', 'OPENVINO_PLUGIN_PATH']:
    environment.pop(name, None)
model = Path.cwd() / 'ffb-relu.xml'
model.write_text((recipe / 'public-model.xml').read_text())
output = Path.cwd() / 'ffb-sdk'
compile_environment = dict(os.environ)
compile_environment.pop('LD_LIBRARY_PATH', None)
compile_environment['PKG_CONFIG_LIBDIR'] = str(deps / 'lib/pkgconfig')
flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', '--static', 'openvino'],
                                          text=True, env=compile_environment))
subprocess.run([*shlex.split(os.environ.get('CC', 'gcc')),
                str(recipe / 'public-api.c'),
                *flags, '-UNDEBUG', '-o', str(output)], check=True, env=compile_environment)
subprocess.run([str(output), str(model)], timeout=120, check=True, env=environment)
sdk = Path.cwd() / 'ffb-installed-sdk'
subprocess.run(['cmake', '-S', str(recipe / 'sdk-consumer'), '-B', str(sdk), '-G', 'Ninja',
                '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_PREFIX_PATH=' + str(deps),
                '-DOpenVINO_DIR=' + str(deps / 'share/openvino')], check=True, env=compile_environment)
subprocess.run(['cmake', '--build', str(sdk), '--parallel', os.environ['JOBS']],
               check=True, env=compile_environment)
subprocess.run([str(sdk / 'cxx'), str(model)], timeout=120, check=True, env=environment)
for probe in ['bridges', 'exception', 'exception_static']:
    subprocess.run([str(sdk / probe)], timeout=30, check=True, env=environment)
if mode == 'static':
    print('OpenVINO: native installed static C/C++ SDK, CPU/IR inference and exception boundaries passed')
    sys.exit(0)
plugins = ET.parse(deps / 'lib/plugins.xml').findall('.//plugin')
assert {plugin.attrib['name'] for plugin in plugins} == {'CPU'}, plugins
assert all(not Path(plugin.attrib['location']).is_absolute() for plugin in plugins), 'registry must relocate'
standard_runtime = False
for component in ['libopenvino', 'libopenvino_c', 'libopenvino_ir_frontend', 'libopenvino_intel_cpu_plugin']:
    soname = component + ('.so' if component.endswith('_plugin') else '.so.2641')
    library = deps / 'lib' / soname
    dynamic = subprocess.check_output(['readelf', '-d', str(library)], text=True)
    if not component.endswith('_plugin'):
        assert '[' + soname + ']' in dynamic, dynamic
    standard_runtime |= 'libstdc++.so.6' in dynamic
    versions = subprocess.check_output(['readelf', '--version-info', str(library)], text=True)
    requirements = sorted(set(re.findall(r'(?:GLIBCXX|CXXABI)_\d+(?:\.\d+)*', versions)))
    print(soname + ' system C++ ABI requirements: ' + ', '.join(requirements))
assert standard_runtime, 'The native shared CPU runtime must use the system C++ runtime'
print('OpenVINO: complete native C/C++/frontend/CPU module owner, native ABI and relative plugin registry passed')
