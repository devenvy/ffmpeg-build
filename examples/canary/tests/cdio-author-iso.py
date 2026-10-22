"""Regenerate the owned ISO/UDF fixture with Debian genisoimage 9:1.1.11-3.4.

Run in the pinned authoring container described in cdio-fixtures.md. Volume
creation timestamps can change image bytes, so regeneration updates its hash.
"""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ffb-iso-') as temporary:
    root = Path(temporary)
    payload = bytes((index * 37 + 11) % 256 for index in range(4096))
    (root / 'PAYLOAD.BIN').write_bytes(payload)
    (root / 'README.TXT').write_text('FFmpeg Build owned ISO/UDF fixture\n')
    for path in [root / 'PAYLOAD.BIN', root / 'README.TXT', root]:
        os.utime(path, (946684800, 946684800))
    image = output / 'owned.iso'
    subprocess.run(['genisoimage', '-quiet', '-udf', '-V', 'FFB_TEST', '-o', str(image), str(root)], check=True)
data = image.read_bytes()
(output / 'iso.base64').write_text(base64.b64encode(gzip.compress(data, mtime=0)).decode() + '\n')
version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'genisoimage'], text=True)
assert version == '9:1.1.11-3.4', version
(output / 'iso-fixture.json').write_text(json.dumps({
    'authoringPackage': 'Debian bookworm genisoimage ' + version,
    'authoringBinarySha256': hashlib.sha256(Path('/usr/bin/genisoimage').read_bytes()).hexdigest(),
    'imageSha256': hashlib.sha256(data).hexdigest(),
    'payloadSha256': hashlib.sha256(payload).hexdigest(),
    'imageBytes': len(data),
    'payloadBytes': len(payload),
    'note': 'All media/data authored for this test; volume creation timestamps are recorded by genisoimage. Regeneration preserves contents but may change image hash.',
}, indent=2) + '\n')
