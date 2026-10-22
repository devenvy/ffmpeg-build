The audio fixture is authored by `cdio-linkage.mjs` and each recipe's SDK probe.
It contains 750 sectors, 588 stereo 16-bit frames per sector, stored little-endian
in a BINARY CUE image. The left sample is `floor((i % 441) * 40000 / 441) - 20000`;
the right sample is `floor((i % 293) * 24000 / 293) - 8000`. No recorded media is used.
The FFmpeg check compares 225 complete sectors from the longer image, with an
explicit frame bound. It does not claim source end-of-disc coverage. The direct
SDK checks read the first, middle and last sectors and exercise paranoia's
verified reads, seeking and caller-owned CDIO handle lifecycle.

`recipes/libcdio/iso.base64` is a gzip-compressed, base64-encoded owned ISO9660/UDF
image. `iso-fixture.json` records its SHA-256 and authoring binary. It contains
`PAYLOAD.BIN` (4096 bytes, byte `i` equals `(i * 37 + 11) % 256`) and `README.TXT`.
The SDK checks both filesystems' payload path, absent paths, ISO directory-list
ownership across the CDIO API, and UDF's documented error at its end boundary.

Regenerate in a container based on
`mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0`,
with Debian bookworm `genisoimage=9:1.1.11-3.4` installed. Run
`python3 cdio-author-iso.py OUTPUT_DIRECTORY`. The original generator binary SHA
is recorded in the manifest. Input file timestamps are fixed to 2000-01-01 UTC;
the volume creation time can change, so regenerated image hashes may differ.
Review the manifest and rerun the SDK checks when updating the fixture.

These fixture generators and authoring tools are not included in FFmpeg's
runtime archive. CI decodes the committed small fixture and needs no image
authoring package or optical drive.
