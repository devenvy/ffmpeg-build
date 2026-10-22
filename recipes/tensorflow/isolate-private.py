"""Give TensorFlow's private Protobuf, oneDNN and Xbyak symbols their own names throughout its static closure."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

archives = [Path(arg) for arg in sys.argv[2:]]
mapping = Path(sys.argv[1])
if not archives:
    raise SystemExit('No TensorFlow archives to isolate')

def command(name, default):
    return shlex.split(os.environ.get(name, default))

def symbols(archive):
    with tempfile.TemporaryFile(mode='w+t') as errors:
        # Local/artificial symbols include COMDAT signatures such as a destructor's
        # D5 alias. Leaving those unchanged lets ld discard another runtime's group.
        process = subprocess.Popen(command('NM', 'nm') + ['-P', str(archive)],
                                   stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            for line in process.stdout:
                parts = line.split()
                if len(parts) >= 2 and len(parts[1]) == 1:
                    yield parts[0]
        finally:
            process.stdout.close()
            status = process.wait()
        errors.seek(0)
        detail = errors.read()
        if status or 'plugin needed' in detail or 'file format not recognized' in detail:
            raise SystemExit('Cannot inspect TensorFlow archive (unsupported LTO?): ' + str(archive) + '\n' + detail)

def reject_lto(archive):
    process = subprocess.Popen(command('OBJDUMP', 'objdump') + ['-h', str(archive)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    found = False
    for line in process.stdout:
        found = found or '.gnu.lto_' in line or '__LLVM' in line
    process.stdout.close()
    status = process.wait()
    if found or status:
        raise SystemExit('TensorFlow symbol isolation does not support LTO or unrecognized objects: ' + str(archive))

def groups(archive):
    process = subprocess.Popen(command('READELF', 'readelf') + ['--section-groups', '--wide', str(archive)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for line in process.stdout:
        match = re.search(r'\[([^\[\]\s]+)\]\s+contains', line)
        if match:
            yield match.group(1)
    process.stdout.close()
    if process.wait():
        raise SystemExit('Cannot inspect TensorFlow COMDAT groups: ' + str(archive))

candidates = set()
for archive in archives:
    reject_lto(archive)
    candidates.update(symbol for symbol in set(symbols(archive)).union(groups(archive))
                      if not symbol.startswith('ffb_tf_') and
                      ('6google8protobuf' in symbol or '4dnnl' in symbol or '5Xbyak' in symbol or
                       # Generated descriptor tables also have global TableStruct_* C++ names.
                       'google_2fprotobuf_' in symbol or symbol.startswith('dnnl_')))
if not candidates:
    raise SystemExit('No private TensorFlow Protobuf/oneDNN/Xbyak symbols found; review the pinned dependency closure')
ordered = sorted(candidates)
# Only the C API is installed. All symbols containing private Protobuf/oneDNN/Xbyak types stay private.
private = ordered
mapping.parent.mkdir(parents=True, exist_ok=True)
mapping.write_text(''.join(symbol + ' ffb_tf_' + symbol + '\n' for symbol in private))
for archive in archives:
    subprocess.run(command('OBJCOPY', 'objcopy') + ['--redefine-syms=' + str(mapping), str(archive)], check=True)
    subprocess.run(command('RANLIB', 'ranlib') + [str(archive)], check=True)
    leftover = set(symbols(archive)).union(groups(archive)).intersection(private)
    if leftover:
        raise SystemExit('TensorFlow Protobuf/oneDNN/Xbyak isolation incomplete: ' + ', '.join(sorted(leftover)[:5]))
print('Isolated', len(private), 'private TensorFlow Protobuf/oneDNN/Xbyak symbols; mapping:', mapping, flush=True)
