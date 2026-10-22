"""Author unencrypted DVD media; run with the pinned tools documented in dvd-fixtures.md."""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ffmpeg = str(Path(sys.argv[1]).resolve())
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ffb-dvd-author-') as temporary:
    root = Path(temporary)
    vob = root / 'owned.vob'
    dvd = root / 'dvd'
    subprocess.run([ffmpeg, '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=c=red:size=720x576:rate=25', '-f', 'lavfi', '-i',
                    'sine=frequency=1000:sample_rate=48000', '-t', '3', '-target',
                    'pal-dvd', '-b:v', '1000k', '-maxrate:v', '1000k', '-bufsize:v',
                    '1835008', '-threads', '1', '-y', str(vob)], check=True)
    xml = root / 'dvd.xml'
    xml.write_text(f'<dvdauthor dest="{dvd}"><vmgm><menus><video format="pal" />'
                   '</menus></vmgm><titleset><titles><video format="pal" aspect="4:3" />'
                   f'<pgc><vob file="{vob}" chapters="0,1,2" /></pgc>'
                   '</titles></titleset></dvdauthor>')
    subprocess.run(['dvdauthor', '-x', str(xml)], check=True)
    image = root / 'owned.iso'
    subprocess.run(['genisoimage', '-quiet', '-udf', '-dvd-video', '-V', 'FFB_DVD',
                    '-o', str(image), str(dvd)], check=True)
    buffer = io.BytesIO()
    hashes = {}
    with tarfile.open(fileobj=buffer, mode='w') as package:
        for path in sorted([image, *dvd.rglob('*')]):
            if not path.is_file():
                continue
            name = path.relative_to(root).as_posix()
            data = path.read_bytes()
            hashes[name] = hashlib.sha256(data).hexdigest()
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mtime = 946684800
            entry.mode = 0o644
            package.addfile(entry, io.BytesIO(data))
    payload = buffer.getvalue()
    (output / 'dvd.base64').write_text(base64.b64encode(gzip.compress(payload, mtime=0)).decode() + '\n')
    packages = {}
    for name in ['dvdauthor', 'genisoimage']:
        packages[name] = {
            'version': subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', name], text=True),
            'binarySha256': hashlib.sha256(Path('/usr/bin', name).read_bytes()).hexdigest(),
        }
    assert packages['dvdauthor']['version'] == '0.7.2-2', packages
    assert packages['genisoimage']['version'] == '9:1.1.11-3.4', packages
    (output / 'dvd-fixture.json').write_text(json.dumps({
        'authoringPackages': packages,
        'ffmpegVersion': subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0],
        'tarSha256': hashlib.sha256(payload).hexdigest(),
        'files': hashes,
        'media': 'Owned 3-second 720x576 PAL red video, 48kHz 1kHz mono sine, chapters at authored GOP boundaries; no copyrighted inputs or encryption.',
        'note': 'Volume creation timestamps can change on regeneration; retain and check the new file hashes.',
    }, indent=2) + '\n')
