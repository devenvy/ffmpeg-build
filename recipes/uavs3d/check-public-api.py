import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
header = Path(deps, "include", "uavs3d.h").read_text()
header = re.sub(r"/\*.*?\*/", "", header, flags=re.S)
header = re.sub(r"//[^\n]*", "", header)
header = re.sub(r"(?m)^\s*#.*$", "", header)
public = set(re.findall(r"\bAVS3D_API\s+[^;{}]*?\b(uavs3d_\w+)\s*\(", header))
assert public, "Installed SDK must declare public functions"
library = Path(deps, "lib", "libuavs3d.so")
symbols = subprocess.check_output(["nm", "-D", "--defined-only", library], text=True)
names = {line.split()[-1] for line in symbols.splitlines() if line.split()}
assert names == public, (names - public, public - names)
dynamic = subprocess.check_output(["readelf", "-d", library], text=True)
assert "[libuavs3d.so]" in dynamic, dynamic
source = Path(os.environ["RECIPES"], "uavs3d", "public-api.c")
subprocess.run(shlex.split(compiler) + [str(source), "-I" + str(Path(deps, "include")),
    "-L" + str(Path(deps, "lib")), "-luavs3d", "-o", output], check=True)
environment = dict(os.environ, LD_LIBRARY_PATH=str(Path(deps, "lib")), LD_BIND_NOW="1")
subprocess.run([output], env=environment, check=True, timeout=30)
print(f"AVS3 installed SDK: all {len(public)} public exports and native SONAME passed")
