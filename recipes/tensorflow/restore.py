"""Restore a TensorFlow input inventory from an extracted sources archive."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def restore(catalog, kept, source):
    data = json.loads(catalog.read_text())
    if data['version'] != 1:
        raise SystemExit('Unsupported source-input inventory version')
    source.mkdir(parents=True, exist_ok=True)
    source = source.resolve()
    kept = kept.resolve()
    for entry in data['files']:
        name = entry['path']
        sha = entry['sha256']
        if (Path(name).is_absolute() or '\\' in name or '..' in name.split('/') or re.match(r'^[A-Za-z]:', name) or
                not re.fullmatch(r'[0-9a-f]{64}', sha)):
            raise SystemExit('Unsafe source-input inventory entry')
        target = (source / name).resolve()
        original = (kept / 'supplemental' / sha).resolve()
        if not target.is_relative_to(source) or not original.is_relative_to(kept):
            raise SystemExit('Source-input path escapes its source folder')
        if digest(original) != sha:
            raise SystemExit('Preserved source-input checksum mismatch: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
    inputs = source / '.ffb_inputs'
    (inputs / 'bazel-7.7.0').chmod(0o755)
    go_pin = next(entry for entry in data['files'] if entry['repository'] == 'go-sdk-build-tool')
    go = inputs / 'go-sdk'
    go.mkdir(exist_ok=True)
    subprocess.run(['tar', '-xf', str(source / go_pin['path']), '-C', str(go), '--strip-components=1'], check=True)
    shutil.copy2(catalog, source / 'ffb-source-inputs.json')
    print('Restored', len(data['files']), 'verified input paths', flush=True)

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: restore.py <inventory.json> <kept-sources-folder> <tensorflow-source-folder>')
    restore(*map(Path, sys.argv[1:]))
