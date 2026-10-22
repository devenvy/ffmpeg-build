The H.264 fixture contains three authored solid-red 16×16 frames at one frame per second.
It was generated with libx264 in a verified engine archive, using `-preset ultrafast
-tune zerolatency -pix_fmt yuv420p`. Its SHA-256 is
`845bcdec78b47f7df7fdd10a9035ac53d7f3b1bfc3335299e0c411a9184633e1`.

The maintained check decodes all frames through natural EOF in software, lists the
Rockchip codecs, and attempts the hardware decoder only when no Rockchip device
node exists. The native SDK probe separately exercises packet/frame ownership,
imported caller-owned normal buffers and the legacy VPU wrapper. These checks do
not claim hardware decode or encode coverage.
