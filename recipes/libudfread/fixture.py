"""Unpack only the checked, owned Blu-ray fixture files."""
import base64
import hashlib
import io
import json
import lzma
from pathlib import Path
import tarfile


def prepare(recipe, destination):
    recipe = Path(recipe)
    destination = Path(destination)
    manifest = json.loads((recipe / 'bluray-fixture.json').read_text())
    payload = lzma.decompress(base64.b64decode((recipe / 'bluray.base64').read_bytes()))
    assert hashlib.sha256(payload).hexdigest() == manifest['tarSha256']
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(payload)) as package:
        for entry in package:
            assert entry.isfile() and entry.name in manifest['files'], entry.name
            assert not Path(entry.name).is_absolute() and '..' not in Path(entry.name).parts
            contents = package.extractfile(entry).read()
            assert hashlib.sha256(contents).hexdigest() == manifest['files'][entry.name]
            path = destination / entry.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)
            seen.add(entry.name)
    assert seen == set(manifest['files'])
    return destination
