"""Check the complete native export surface and build owned Windows SDK probes."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

cc = shlex.split(sys.argv[1])
deps = Path(sys.argv[2])
recipe = Path(os.environ['RECIPES']) / 'vulkan-shim'
sdk = Path('ffb-sdk')
sdk.mkdir(exist_ok=True)
objdump = subprocess.check_output(cc + ['-print-prog-name=objdump'], text=True).strip()
library = deps / 'bin/ffb-vulkan-shim.dll'
pe = subprocess.check_output([objdump, '-p', str(library)], text=True)
expected = set(re.findall(r'^\w[^\n]* VKAPI_CALL (vk\w+)\(', Path('_build/loader.c').read_text(), re.M))
actual = set(re.findall(r'^\s*\[\s*\d+\]\s+(\w+)\s*$', pe, re.M))
if not expected or actual != expected:
    raise SystemExit(f'Native export mismatch: missing={expected-actual}, extra={actual-expected}')
imports = re.findall(r'DLL Name:\s*(\S+)', pe)
if {name.lower() for name in imports} - {'kernel32.dll', 'msvcrt.dll'}:
    raise SystemExit(f'Unshipped compiler dependency or hard driver import: {imports}')
subprocess.run(cc + ['-O2', '-I', 'Vulkan-Headers/include', str(recipe / 'public-api.c'),
                    str(deps / 'lib/libvulkan-1.dll.a'), '-o', str(sdk / 'sdk.exe')], check=True)
sdk_pe = subprocess.check_output([objdump, '-p', str(sdk / 'sdk.exe')], text=True)
sdk_imports = {name.lower() for name in re.findall(r'DLL Name:\s*(\S+)', sdk_pe)}
if 'ffb-vulkan-shim.dll' not in sdk_imports or sdk_imports - {
    'ffb-vulkan-shim.dll', 'kernel32.dll', 'msvcrt.dll'
}:
    raise SystemExit(f'The import-linked SDK has an incorrect DLL owner or closure: {sdk_imports}')
for mode in ('positive', 'failed-load'):
    flags = ['-DFFB_FAIL_LOAD'] if mode == 'failed-load' else []
    subprocess.run(cc + ['-shared', '-O2'] + flags + ['-I', 'Vulkan-Headers/include',
                   str(recipe / 'driver-fixture.c'), '-o', str(sdk / f'{mode}.dll')], check=True)
print(f'Vulkan shim: all {len(expected)} native exports preserved, distinct import owner and driver-optional PE closure passed')
