The DVD fixture contains media authored for these tests: three seconds of PAL
720x576 red MPEG-2 video and a 48 kHz, 1 kHz mono AC-3 sine. No input media,
encryption keys, or decryption libraries are used. The authored title has three
chapters, quantized by dvdauthor to MPEG GOP boundaries at 0, 1.2 and 1.8 seconds.

`dvd-author-fixture.py FFMPEG OUTPUT` recreates a DVD folder and an ISO using
FFmpeg 9.0.2, Debian bookworm dvdauthor 0.7.2-2 and genisoimage 9:1.1.11-3.4.
The authoring container used the pinned base
`mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0`
with those exact packages installed. This is fixture authoring tooling; runtime
tests require neither program. The manifest records binary hashes and the hash
of every retained file. Volume creation timestamps can change when regenerating;
review and retain the regenerated manifest with both fixture copies.

`dvd.base64` is a gzip-compressed tar containing only the ISO and DVD folder.
Identical copies and manifests live here and in `recipes/libdvdread`. Public SDK
probes read the entire title VOB through DVDRead, parse PAL/AC-3 IFO metadata,
exercise DVDNav cache allocation/free across the library boundary, query chapters,
reject an invalid title, and navigate to a natural STOP. The FFmpeg canary decodes
both folder and ISO to natural EOF, checks all 75 red frames, exact decoded audio
length, tone frequency/amplitude, chapter boundaries and missing-image rejection.
The AC-3 stream starts at 0.058667 seconds in the authored title, so its decoded
audio is 141312 samples; the test checks that retained authored timing.

These tests exercise unencrypted software images. They do not claim optical-drive,
CSS, region-protected media or hardware playback coverage.
