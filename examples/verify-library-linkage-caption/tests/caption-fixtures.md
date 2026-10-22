The ARIB and Teletext fixtures contain authored `FFB` text, not recorded broadcasts.
Run `python3 author-captions.py` to regenerate their base64 and SHA-256 manifest.

ARIB uses a Japanese profile A management packet, a medium-size Latin `FFB`
statement and a clear statement. The CRC-16 uses polynomial 0x1021 and seed 0.
The original aribb24 decoder returns fullwidth letters; libaribcaption's text
configuration returns ASCII. Both are asserted explicitly.

Teletext contains page 100, its authored row and a page 101 header to flush it.
Header nibbles use Hamming 8/4, text uses odd parity, and transmitted bytes are
bit-reversed. The native SDK also exercises the installed inline table APIs.

Both transport streams have checked PAT/PMT CRC-32, PES timestamps and 188-byte
packets. They intentionally have no PCR clock. The Teletext test sets
`-fix_teletext_pts 0` to retain encoded PES timestamps rather than replace them
with an absent PCR. No decoder implementation is changed for these fixtures.

The recipe SDK probes additionally render captions with the engine's authored
`FFB Test` font, exercise libaribcaption's public C++ ownership/string/vector API,
and roundtrip authored KLVANC AFD data through SMPTE 2038 with a checksum-negative
case. DeckLink device I/O needs hardware and the separately installed system
driver; only the device listing, full build and software ancillary payload paths
are verified here.
