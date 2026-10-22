# Authored Pixman checks

The Pixman targets build FFmpeg 8/9 with static Cairo and either static or bundled shared Pixman.
`pixman-linkage.mjs` draws an owned red rectangle on a black RGB frame through the real `drawvg`
filter. Every pixel is checked. A translated path must produce the identical frame. No fonts,
external media, display server or graphics hardware is required.

Shared recipe builds also compile the installed C SDK. Owned ARGB buffers check exact SRC and OVER
compositing, an A8 mask, clipping and nearest-neighbour translation. Reference counts and destroy
callbacks verify object lifetime. Half-transparent colors use Pixman's premultiplied representation.

The native `libpixman-1.so.0` ABI and visibility remain unchanged, including the upstream test-only
`_pixman_internal_only_get_implementation` export. The installed public API is retained; no new
export map removes upstream entry points. Native SDK checks were also run against the exact shared
libraries extracted from every final runtime archive.
