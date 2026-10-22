"""Round-trip authored PCM through the installed shared libsndfile C API."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "libsndfile" / "public-api.c"
subprocess.run([
    *shlex.split(os.environ.get("CC", "gcc")), str(source),
    f"-I{deps / 'include'}", f"-L{deps / 'lib'}", "-lsndfile", "-lm",
    "-o", str(program),
], check=True)
subprocess.run([str(program), str(program.with_suffix('.wav'))], check=True, env={
    **os.environ, "LD_LIBRARY_PATH": str(deps / "lib")
})
