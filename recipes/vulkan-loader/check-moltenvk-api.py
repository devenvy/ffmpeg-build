"""Compile the complete native Vulkan SDK probe; hardware runs belong to CI tests."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

deps = Path(sys.argv[1])
cc = shlex.split(sys.argv[2])
source = Path(os.environ['RECIPES']) / 'vulkan-loader/moltenvk-api.c'
sdk = Path('ffb-sdk')
sdk.mkdir(exist_ok=True)
frameworks = ('Metal', 'Foundation', 'QuartzCore', 'CoreGraphics', 'IOSurface', 'IOKit', 'AppKit')
flags = [item for framework in frameworks for item in ('-framework', framework)]
subprocess.run(cc + ['-O2', '-UNDEBUG', '-I', str(deps / 'include'), str(source), '-L', str(deps / 'lib'),
                    '-lvulkan', '-lc++', '-Wl,-rpath,@executable_path'] + flags +
               ['-o', str(sdk / 'moltenvk-api')], check=True)
print('Native MoltenVK SDK: complete public Vulkan API consumer compiled; hardware execution deferred to runtime tests')
