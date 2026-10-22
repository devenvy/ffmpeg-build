"""Author owned Blu-ray/UDF fixtures using the pinned tools in bluray-fixtures.md."""
import base64
import hashlib
import io
import json
import lzma
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ffmpeg = str(Path(sys.argv[1]).resolve())
tsmuxer = str(Path(sys.argv[2]).resolve())
output = Path(sys.argv[3]).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ffb-bluray-author-') as temporary:
    root = Path(temporary)
    video = root / 'owned.m2v'
    audio = root / 'owned.ac3'
    subprocess.run([ffmpeg, '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=c=blue:size=1280x720:rate=25', '-t', '180', '-c:v', 'mpeg2video',
                    '-pix_fmt', 'yuv420p', '-b:v', '1000k', '-threads', '1', '-f',
                    'mpeg2video', '-y', str(video)], check=True)
    subprocess.run([ffmpeg, '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
                    'sine=frequency=750:sample_rate=48000:duration=3,apad=whole_dur=180', '-t', '180', '-c:a', 'ac3',
                    '-b:a', '192k', '-y', str(audio)], check=True)
    meta = root / 'owned.meta'
    meta.write_text('MUXOPT --blu-ray --constant-iso-hdr '
                    '--custom-chapters=00:00:00.000;00:01:00.000;00:02:00.000\n'
                    f'V_MPEG-2, {video}, fps=25\nA_AC3, {audio}\n')
    disc = root / 'disc'
    image = root / 'owned.iso'
    subprocess.run([tsmuxer, str(meta), str(disc)], check=True)
    subprocess.run([tsmuxer, str(meta), str(image)], check=True)
    buffer = io.BytesIO()
    hashes = {}
    with tarfile.open(fileobj=buffer, mode='w') as package:
        for path in sorted([image, *disc.rglob('*')]):
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
    (output / 'bluray.base64').write_text(base64.b64encode(lzma.compress(payload, preset=9)).decode() + '\n')
    (output / 'bluray-fixture.json').write_text(json.dumps({
        'tsmuxerSource': 'https://github.com/justdan96/tsMuxer/tree/c6b1186209e42c877052e762c9185f3226ef8ea2',
        'tsmuxerSourceArchiveSha256': '09e028daee4ec96f3299cb3218151e334ba5bf2eeb444dd1ae7a01ed3de95bb4',
        'tsmuxerBinarySha256': hashlib.sha256(Path(tsmuxer).read_bytes()).hexdigest(),
        'ffmpegVersion': subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0],
        'tarSha256': hashlib.sha256(payload).hexdigest(),
        'compression': 'xz-preset9',
        'files': hashes,
        'media': 'Owned 180-second 1280x720 blue MPEG-2 video and three authored chapters. Audio is a 48kHz750Hz mono AC-3 sine for three seconds followed by177seconds of silence. No copyrighted inputs or encryption. FFmpeg requires a playlist of at least180seconds even when selecting it explicitly.',
    }, indent=2) + '\n')
