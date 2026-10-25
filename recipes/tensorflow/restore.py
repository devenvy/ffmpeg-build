"""Restore a TensorFlow input inventory from an extracted sources archive."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sdk_build(archive):
    # Render the authoritative rules_go SDK template using its own _sdk_build_file
    # substitutions. This creates configuration for the unchanged Go tool archive.
    with zipfile.ZipFile(archive) as bundle:
        template = bundle.read('go/private/BUILD.sdk.bazel')
    for name, value in {
        b'{goos}': b'linux', b'{goarch}': b'amd64', b'{exe}': b'',
        b'{rules_go_repo_name}': b'io_bazel_rules_go',
    }.items():
        if name not in template:
            raise SystemExit('Review the native rules_go SDK template: missing ' + repr(name))
        template = template.replace(name, value)
    return template


def prepare_go(source, files):
    archive = next(entry for entry in files if entry['repository'] == 'go-sdk-build-tool')
    rules = next(entry for entry in files if entry['repository'] == 'io_bazel_rules_go')
    for entry in [archive, rules]:
        if digest(source / entry['path']) != entry['sha256']:
            raise SystemExit('Native Go SDK input checksum mismatch: ' + entry['repository'])
    go = source / '.ffb_inputs/go-sdk'
    go.mkdir(exist_ok=True)
    subprocess.run(['tar', '-xf', str(source / archive['path']), '-C', str(go), '--strip-components=1'], check=True)
    (go / 'BUILD.bazel').write_bytes(sdk_build(source / rules['path']))
    for name in ['ROOT', 'REPO.bazel']:
        (go / name).write_bytes(b'')
    provenance = {**rules, 'member': 'go/private/BUILD.sdk.bazel',
                  'substitutions': {'goos': 'linux', 'goarch': 'amd64', 'exe': '',
                                    'rules_go_repo_name': 'io_bazel_rules_go'}}
    (source / '.ffb_inputs/go-sdk-template.json').write_text(json.dumps(provenance, indent=2) + '\n')

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
    prepare_go(source, data['files'])
    shutil.copy2(catalog, source / 'ffb-source-inputs.json')
    print('Restored', len(data['files']), 'verified input paths', flush=True)

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: restore.py <inventory.json> <kept-sources-folder> <tensorflow-source-folder>')
    restore(*map(Path, sys.argv[1:]))
