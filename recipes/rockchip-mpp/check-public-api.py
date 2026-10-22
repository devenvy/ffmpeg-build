import os
from pathlib import Path
import shlex
import subprocess
import sys

deps = Path(sys.argv[1])
environment = dict(os.environ)
for name in ['LD_LIBRARY_PATH', 'LIBRARY_PATH']:
    environment.pop(name, None)
output = Path.cwd() / 'ffb-rockchip-sdk'
subprocess.run([*shlex.split(os.environ.get('CC', 'cc')),
                Path(os.environ['RECIPES']) / 'rockchip-mpp/public-api.c',
                '-DFFB_MPP_SHARED=1', '-I' + str(deps / 'include'),
                '-L' + str(deps / 'lib'), '-lrockchip_vpu', '-lrockchip_mpp',
                '-ldl', '-lm', '-pthread', '-o', output], check=True, env=environment)
environment.update(LD_LIBRARY_PATH=str(deps / 'lib'), LD_BIND_NOW='1', use_mpp_mode='1')
subprocess.run([output], timeout=30, check=True, env=environment)
consumer_dynamic = subprocess.check_output(['readelf', '-d', output], text=True)
for name in ['librockchip_mpp.so.1', 'librockchip_vpu.so.1']:
    assert '[' + name + ']' in consumer_dynamic, consumer_dynamic
for name in ['librockchip_mpp', 'librockchip_vpu']:
    library = deps / ('lib/' + name + '.so.1')
    dynamic = subprocess.check_output(['readelf', '-d', library], text=True)
    assert '[' + name + '.so.1]' in dynamic, dynamic
    assert (deps / ('lib/' + name + '.so.0')).exists(), 'preserve native VERSION0/SOVERSION1'
    assert 'libstdc++.so' not in dynamic, dynamic
    symbols = subprocess.check_output(['nm', '-D', '--defined-only', library], text=True)
    names = {line.split()[-1].split('@')[0] for line in symbols.splitlines() if line.split()}
    assert not any(symbol.startswith(('_ZSt', '_ZNSt', '_ZNKSt', '__cxa_', '_Unwind_')) for symbol in names)
    required = ['mpp_create', 'mpp_frame_init', 'mpp_packet_copy_init', 'mpp_buffer_import_with_tag'] if name.endswith('_mpp') else ['vpu_open_context', 'vpu_close_context', 'VPUClientInit']
    assert set(required) <= names, set(required) - names
print('Rockchip: complete native MPP/VPU owner, ABI1 with VERSION0 and private compiler closure passed')
