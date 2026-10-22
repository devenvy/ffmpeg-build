"""Call the actual AVX2 predictor from both valid SysV stack alignments."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

deps = Path(sys.argv[1])
program = Path(sys.argv[2])
source = Path(os.environ["RECIPES"]) / "davs2"
subprocess.run([
    *shlex.split(os.environ.get("CXX", "g++")),
    "-std=c++17", "-O2", "-mpreferred-stack-boundary=4",
    str(source / "stack-abi.cc"), str(source / "stack-abi.S"),
    str(deps / "lib" / "libdavs2.a"), "-static-libstdc++", "-shared-libgcc", "-lm", "-pthread", "-o", str(program),
], check=True)
for arguments in ([], ["16"]):
    result = subprocess.run([str(program), *arguments], check=False)
    if result.returncode == 77:
        print("Davs2 AVX2 stack ABI probe skipped: host CPU lacks AVX2")
        break
    result.check_returncode()
    print(f"Davs2 AVX2 stack ABI probe passed: {'16' if arguments else '32'}-byte caller")
