"""Exercise the installed shared time voice and its language dependency chain."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "flite" / "time-voice.c"
subprocess.run([
    *shlex.split(os.environ.get("CC", "gcc")),
    str(source), f"-I{deps / 'include'}", f"-L{deps / 'lib'}",
    "-lflite_cmu_time_awb", "-lflite_usenglish", "-lflite_cmulex",
    "-lflite", "-lm", "-o", str(program),
], check=True)
subprocess.run([str(program)], check=True, env={
    **os.environ, "LD_LIBRARY_PATH": str(deps / "lib")
})
