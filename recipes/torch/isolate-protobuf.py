"""Give Torch's private Protobuf symbols their own names throughout its static closure."""
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
    raise SystemExit('No Torch archives to isolate')

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
            raise SystemExit('Cannot inspect Torch archive (unsupported LTO?): ' + str(archive) + '\n' + detail)

def reject_lto(archive):
    process = subprocess.Popen(command('OBJDUMP', 'objdump') + ['-h', str(archive)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    found = False
    for line in process.stdout:
        found = found or '.gnu.lto_' in line or '__LLVM' in line
    process.stdout.close()
    status = process.wait()
    if found or status:
        raise SystemExit('Torch symbol isolation does not support LTO or unrecognized objects: ' + str(archive))

def groups(archive):
    process = subprocess.Popen(command('READELF', 'readelf') + ['--section-groups', '--wide', str(archive)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for line in process.stdout:
        match = re.search(r'\[([^\[\]\s]+)\]\s+contains', line)
        if match:
            yield match.group(1)
    process.stdout.close()
    if process.wait():
        raise SystemExit('Cannot inspect Torch COMDAT groups: ' + str(archive))

candidates = set()
for archive in archives:
    reject_lto(archive)
    candidates.update(symbol for symbol in set(symbols(archive)).union(groups(archive))
                      if not symbol.startswith('ffb_torch_') and
                      ('6google8protobuf' in symbol or symbol.startswith('descriptor_table_google_2fprotobuf_')))
if not candidates:
    raise SystemExit('No private Torch Protobuf symbols found; review the pinned dependency closure')
ordered = sorted(candidates)
demangled = subprocess.check_output(command('CXXFILT', 'c++filt'),
                                    input='\n'.join(ordered) + '\n', text=True).splitlines()
if len(demangled) != len(ordered):
    raise SystemExit('Incomplete Torch symbol demangling')
# A public Torch function can mention a private type in its arguments. Keep that
# public function's name; only its internal calls to Protobuf need rewriting.
private = [symbol for symbol, readable in zip(ordered, demangled)
           if not re.search(r'(?:^| )(?:torch|at|c10)::', readable.partition('(')[0])]
mapping.parent.mkdir(parents=True, exist_ok=True)
mapping.write_text(''.join(symbol + ' ffb_torch_' + symbol + '\n' for symbol in private))
for archive in archives:
    subprocess.run(command('OBJCOPY', 'objcopy') + ['--redefine-syms=' + str(mapping), str(archive)], check=True)
    subprocess.run(command('RANLIB', 'ranlib') + [str(archive)], check=True)
    leftover = set(symbols(archive)).union(groups(archive)).intersection(private)
    if leftover:
        raise SystemExit('Torch Protobuf isolation incomplete: ' + ', '.join(sorted(leftover)[:5]))
print('Isolated', len(private), 'private Torch Protobuf symbols; mapping:', mapping, flush=True)
