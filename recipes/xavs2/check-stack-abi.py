"""Call the actual AVX2 predictor from both valid SysV stack alignments."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "xavs2"
subprocess.run([
    *shlex.split(os.environ.get("CC", "gcc")),
    "-std=c11", "-O2", "-mpreferred-stack-boundary=4",
    str(source / "stack-abi.c"), str(source / "stack-abi.S"),
    str(deps / "lib" / "libxavs2.a"), "-lm", "-pthread", "-o", str(program),
], check=True)
for arguments in ([], ["16"]):
    result = subprocess.run([str(program), *arguments], check=False)
    if result.returncode == 77:
        print("Xavs2 AVX2 stack ABI probe skipped: host CPU lacks AVX2")
        break
    result.check_returncode()
    print(f"Xavs2 AVX2 stack ABI probe passed: {'16' if arguments else '32'}-byte caller")
