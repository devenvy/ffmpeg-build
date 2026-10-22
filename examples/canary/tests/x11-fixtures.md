The maintained X11 canary starts an isolated Xvfb display with a random owned
MIT-MAGIC-COOKIE-1 authority record. It paints the root red, captures exact RGB
pixels with x11grab, checks the XFixes cursor path, executes the region-outline
path and rejects a wrong cookie. `-noreset` preserves the authored root between
short-lived clients. Xvfb has no XVideo adaptor: the xv output device must open
the display and fail cleanly for that documented limitation. It does not claim
successful XVideo output or physical-display coverage.

Test tooling is Xvfb, xauth, xdpyinfo, xsetroot and xdotool. It is installed in the
temporary verification runtime container and Ubuntu verification job, outside the
production toolchain images. The runtime check asserts the complete native XCB
inventory: core plus 24 enabled extension libraries, including sync/XKB SONAME 1
and the other extension SONAMEs 0. X11 includes its X11-xcb companion library.

`x11-public-api.c` is a separate native SDK probe. Compile it against a selected
engine deps prefix using the `xv xext x11-xcb x11 xcb-shm xcb-shape xcb-xfixes
xcb-randr xcb xau` pkg-config modules (`--static` includes the selected closure).
Run it on an authenticated 320x240x24 Xvfb display. It checks owned Xauth record
read/write/free, exact Xlib pixels, MIT-SHM attach/put/detach, and concurrent Xlib
and Xext requests after XInitThreads. Its bridge borrows XGetXCBConnection,
primes extension caches in different orders on separate connections, compares
cached metadata with raw SHM/SHAPE/XFIXES/RANDR queries, draws through XCB and
transfers event ownership back to Xlib. Only XCloseDisplay closes the borrowed
connection. Xv query/adaptor enumeration pairs allocation and release.

Run the same probe with `FFB_XV_DISABLED=1` and Xvfb's `-extension XVideo` option
to verify that Xv's missing-extension callback reaches the selected Xext handler.
Both SDK probes passed locally against the exact library files from all nine
FFmpeg 8/9 static/shared/mixed runtime archives. These native SDK tests are
separate from the maintained FFmpeg capture canary.

Shared X11 requires shared XCB; shared Xext requires shared X11; shared Xv
requires shared Xext. These transitive constraints preserve one implementation
for connection state, extension IDs, locking and extension-error handlers. Static
upper libraries may consume shared lower libraries; Xau is independent. The
planner reports incompatible selections without silently changing defaults.
