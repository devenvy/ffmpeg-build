"""Check the built shared library against this source version's public C API."""

import re
import subprocess
import sys
from pathlib import Path

header = Path(sys.argv[1]).read_text()
declared = set(re.findall(
    r"CHROMAPRINT_API\b[^;{}]*?\b(chromaprint_\w+)\s*\(", header
))
if not declared:
    raise RuntimeError("No public Chromaprint functions found in the pinned header")
library = Path(sys.argv[2]) / "libchromaprint.so"
symbols = subprocess.check_output(
    ["nm", "-D", "--defined-only", "--format=posix", str(library)], text=True
)
exported = {line.split()[0].split("@")[0] for line in symbols.splitlines() if line.strip()}
missing = declared - exported
private = {name for name in exported if not name.startswith("chromaprint_")}
if missing or private:
    raise RuntimeError(
        f"Chromaprint shared exports: missing={sorted(missing)}, private={sorted(private)}"
    )
print(f"Chromaprint shared exports: all {len(declared)} declared C functions preserved; private symbols hidden")
