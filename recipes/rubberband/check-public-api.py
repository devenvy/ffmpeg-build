"""Link an external C++ consumer against the installed shared public API."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "rubberband" / "public-api.cc"
subprocess.run([
    *shlex.split(os.environ.get("CXX", "g++")),
    "-std=c++17", str(source), f"-I{deps / 'include'}", f"-L{deps / 'lib'}",
    "-lrubberband", "-static-libstdc++", "-shared-libgcc", "-pthread",
    "-o", str(program),
], check=True)
subprocess.run([str(program)], check=True, env={
    **os.environ, "LD_LIBRARY_PATH": str(deps / "lib")
})
subprocess.run([sys.executable, str(source.parent / 'check-allocator.py'), str(deps),
                str(program), os.environ.get('CXX', 'g++')], check=True)
