The Blu-ray fixture is authored media: 180 seconds of blue 1280x720 MPEG-2 video,
48 kHz mono AC-3 audio containing a 750 Hz sine for three seconds followed by
silence, and three chapters at 0, 60 and 120 seconds. No input media, encryption
keys or decryption libraries are used. FFmpeg's Blu-ray protocol requires a
playlist at least 180 seconds long before selecting any playlist, including an
explicitly selected one. A three-second fixture works with libbluray directly
but cannot exercise the unchanged FFmpeg protocol.

`bluray-author-fixture.py FFMPEG TSMUXER OUTPUT` recreates the folder and ISO.
The FFmpeg version and authoring executable hash are recorded in the manifest.
The tsMuxer source is pinned at
`c6b1186209e42c877052e762c9185f3226ef8ea2`, downloaded from its
[upstream repository](https://github.com/justdan96/tsMuxer/tree/c6b1186209e42c877052e762c9185f3226ef8ea2).
Its source archive SHA256 is recorded in the manifest. It was built using CMake
with `-DCMAKE_BUILD_TYPE=Release -DTSMUXER_GUI=OFF -DTSMUXER_STATIC_BUILD=OFF`
and Debian bookworm's compiler, zlib and FreeType development packages. This is
fixture authoring tooling, separate from production toolchain images.

The base image was
`mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0`.
`--constant-iso-hdr` makes the ISO's header timestamps deterministic. The
fixture is an xz-compressed tar encoded as base64, duplicated with its manifest
here and in `recipes/libudfread`. The generator records the uncompressed tar
and each retained file's SHA256. Runtime canaries need `xz`, not tsMuxer.

Public C SDK probes parse title/clip/chapter/stream metadata, read the exact
14585856-byte raw transport file, play the full title to EOF, seek back, and
exercise allocation/free across the ABI. Upstream's playback filter converts
one clip-boundary audio packet's PID to padding; the probe requires exactly
that transformation and preserves every other byte. It checks the raw file
separately without normalization. libudfread probes read directories and exact
file bytes, seek, read blocks, handle EOF/missing files, and open the ISO through
external block callbacks with a checked close lifetime.

FFmpeg canaries read all 4500 video and 5625 audio packets to EOF from both
folder and ISO. They decode 75 blue video frames and one second of audio,
checking exact output lengths, color, tone frequency/amplitude and matching
audio between folder and ISO. They reject absent images and invalid playlists.
The tone measurement excludes encoder priming from its period calculation.
These are unencrypted software-image tests; no optical-drive, AACS, BD+, BD-J
menu, subtitle or protected-media coverage is claimed.
