"""Exercise installed tracker C++ APIs using a wholly authored ProTracker module."""

import math
import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
library = sys.argv[3]
source = Path(os.environ["RECIPES"]) / library / "public-api.cc"
module = bytearray(1084 + 1024 + 64)
module[:14] = b"FFB own module"
module[42:44] = (32).to_bytes(2, 'big')
module[45] = 64
module[48:50] = (32).to_bytes(2, 'big')
module[950] = 1
module[951] = 127
module[1080:1084] = b"M.K."
module[1084:1088] = bytes([1, 172, 16, 0])
for index in range(64):
    module[2108 + index] = round(90 * math.sin(2 * math.pi * index / 64)) & 255
fixture = program.with_suffix('.mod')
fixture.write_bytes(module)
subprocess.run([
    *shlex.split(os.environ.get("CXX", "g++")), "-std=c++17", str(source),
    f"-I{deps / 'include'}", f"-L{deps / 'lib'}", f"-l{library.removeprefix('lib')}",
    "-static-libstdc++", "-shared-libgcc", "-pthread", "-o", str(program),
], check=True)
subprocess.run([str(program), str(fixture)], check=True, env={
    **os.environ, "LD_LIBRARY_PATH": str(deps / "lib")
})
