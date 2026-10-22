The terminal canary generates three FFmpeg testsrc2 frames. Libcaca's raw driver
exports three native 80x24 canvases; the test parses their magic, sizes, version,
frame geometry and all character/attribute cells. ASCII dithering must produce
multiple printable characters and colors. No external media is used.

The ncurses driver runs in an owned 24x80 pseudoterminal with `TERM=xterm` and
UTF-8 locale. The Python harness drains output and compares the exact terminal
settings before and after the process. It retains the output transcript, and
the canary requires actual terminal drawing sequences. Null-driver completion
and invalid-driver rejection are supplementary checks. No physical terminal or
interactive input is required.

Shared recipe SDK probes run in the actual Linux x64 toolchain. Ncurses probes
exercise a Unicode wide-character window, panel show/hide/move and ownership,
menu selection, form editing/validation, public globals and terminfo tables,
and switching two screens while checking their stdscr/cur_term identities.
They restore the pseudoterminal's original settings. All four native libraries
and public data exports are checked. Libcaca probes exercise owned canvas
characters/attributes/resize, exact native export/import with allocation/free,
red-pixel dithering and reading an authored gzip file through caca_file_*.

Ncurses installs no terminfo database; test containers use their recipient's
xterm definition. Shared builds retain the native non-reentrant ABI and full
public data/internal addon exports. No separate tinfo/tic, nonwide or C++
library is introduced. Shared libcaca hides its embedded static ncurses/zlib
exports; independent choices remain available because its public API does not
pass foreign curses objects. The gzip dependency is declared rather than
depending on incidental system development headers/libraries.
