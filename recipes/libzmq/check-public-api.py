import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library = Path(deps, "lib", "libzmq.so")
dynamic = subprocess.check_output(["readelf", "-d", library], text=True)
assert not re.search(r"NEEDED.*libstdc\+\+", dynamic), dynamic
symbols = subprocess.check_output(["nm", "-D", "--defined-only", library], text=True)
names = [line.split()[-1] for line in symbols.splitlines() if line.split()]
assert names and all(name.startswith("zmq_") for name in names), names
source = Path(os.environ["RECIPES"], "libzmq", "public-api.c")
subprocess.run(shlex.split(compiler) + [str(source), "-I" + str(Path(deps, "include")),
    "-L" + str(Path(deps, "lib")), "-lzmq", "-o", output], check=True)
environment = dict(os.environ, LD_LIBRARY_PATH=str(Path(deps, "lib")), LD_BIND_NOW="1")
subprocess.run([output], env=environment, check=True, timeout=30)
