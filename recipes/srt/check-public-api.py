import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

deps, output, compiler = sys.argv[1:]
library = Path(deps, "lib", "libsrt.so")
dynamic = subprocess.check_output(["readelf", "-d", library], text=True)
assert not re.search(r"NEEDED.*libstdc\+\+", dynamic), dynamic
symbols = subprocess.check_output(["nm", "-D", "--defined-only", library], text=True)
assert not re.search(r"\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+", symbols), symbols
source = Path(os.environ["RECIPES"], "srt", "public-api.cc")
subprocess.run(shlex.split(compiler) + [str(source), "-I" + str(Path(deps, "include")),
    "-L" + str(Path(deps, "lib")), "-Wl,-rpath-link," + str(Path(deps, "lib")),
    "-lsrt", "-static-libstdc++", "-shared-libgcc", "-o", output], check=True)
environment = dict(os.environ, LD_LIBRARY_PATH=str(Path(deps, "lib")), LD_BIND_NOW="1")
subprocess.run([output], env=environment, check=True, timeout=30)
