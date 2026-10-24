# Targets: ffmpeg-build.yml

ONNX Runtime CPU inference offers static and bundled shared modes on Linux x64,
with static as its default. Select `link: { onnxruntime: shared }` to ship the
native runtime and provider bridge beside FFmpeg. Authored-model checks cover
complete input EOF and combined inference with TensorFlow, Torch and OpenVINO.

OpenVINO CPU inference offers static and bundled shared modes on Linux x64,
with static as the default. Select `link: { openvino: shared }` to ship its
native C and C++ runtimes, IR frontend, CPU plugin and relative plugin registry.
The installed public APIs and native library ownership are retained. This mode
includes the CPU implementation; GPU plugins require separate support.
Its embedded C++ runtime retains the full native ABI so caller exceptions, streams and teardown share
the correct state. Ten reviewed private dependency archives remain hidden; the system unwinder stays shared.

Torch CPU inference offers static and bundled shared modes on Linux x64,
with static as the default. Select `link: { torch: shared }` to ship its four
native Torch, Torch CPU, c10 and global-dependency libraries. Its installed
C++ API preserves the native compiler exception ABI across library boundaries;
private standard-library instantiations and Protobuf stay inside their owners.
The system unwinder remains shared. SDK checks cover typed errors, callbacks,
tensors and retained external-buffer ownership; cross-library exception tests
also cover nested catches and retained rethrows.

TensorFlow CPU inference offers static and bundled shared modes on Linux x64,
with static as the default. Select `link: { tensorflow: shared }` to ship its
native monolithic C runtime. The Graph and Eager APIs use the same native owner;
the shared mode does not require a separate TensorFlow framework library.
It embeds the pinned C++ compiler archives and requires the system's compatible `libgcc_s.so.1` unwinder.

Rav1e defaults to static linking and offers a bundled shared mode on Linux x64.
It uses cargo-c's native versioned C library and preserves all 37 public C API
functions. Its private Rust implementation remains hidden; the existing static
archive isolation is retained. Rav1e and librsvg can be selected independently:
the verification matrix decodes an owned SVG and encodes it to AV1 in the same
FFmpeg process, including both shared libraries and each mixed Rust combination.
Additional authored frames check decoder reconstruction and complete encoder
draining through natural EOF. Other platforms retain their static defaults.

On Linux x64, Cairo defaults to static and accepts `shared` when both GLib and
Fontconfig are also shared. Cairo's GObject SDK uses the common GType registry;
its font SDK retains Fontconfig objects backed by that library's cache registry.
These ownership requirements are checked during planning. FreeType remains an
independent choice: SDK tests pass external faces through Fontconfig and Cairo,
use borrowed faces, and verify tracked allocators and final destruction.

Shared Cairo bundles its core, GObject and script-interpreter libraries. It keeps
PNG, PDF, PostScript and SVG output. Optional preload development instrumentation
(cairo-trace/FDR) is omitted from the installed package after the unchanged native build;
it is separate from the rendering SDK.

Six FFmpeg 8/9 static/shared/mixed targets check exact drawvg pixels. Native SDK
checks also cover boxed-surface lifetime, PNG and script pixels, vector document
streams, and a real mapped Fontconfig cache with retained patterns passed into
Cairo after releasing explicit cache/configuration handles. The font is authored
test data; no system font or physical display is required.
GNU libiconv offers a bundled shared mode on macOS arm64, with static as its
default. Its library-only build excludes the GPL command-line program. Exact
Latin-9 subtitle conversion and native GNU conversion/error/callback APIs are
checked; this uses the bundled GNU library rather than Apple's system library.
Other Apple platforms and Windows retain their existing static recipes.

On musl Linux x64, proxy-libintl offers static and bundled shared modes, defaulting
to static. It remains GLib's native English-message stub, without translation
catalog loading. The shared library preserves its mutable text domain and public
data; native tests also cover GLib's context/plural wrappers and rendered pixels.
This library is not a replacement for arbitrary system gettext installations.

On Windows, `vulkan-shim` supports static linking only, matching upstream's
build. The shim loads the system Vulkan loader at run time, so FFmpeg can start
and process on the CPU without a Vulkan driver. GPU processing requires an
installed Vulkan driver.

On Windows ARM64, zimg uses upstream's scalar `--disable-simd` build and the compiler's standard
`-include exception` option. This avoids carrying a compatibility header for the release's Windows header-name
assumption. Its conversion API remains available; this platform does not claim zimg's SIMD acceleration.

ZeroMQ is unavailable on Windows ARM64 with the current release: its clock implementation requires an upstream
source fix. LCEVC is unavailable on Windows with the current toolchains: ARM64 has native build incompatibilities,
and the x64 cross image's MinGW SDK 11 lacks a required thread-description declaration. Windows x64 support can be
revisited with a verified SDK 12 or newer build. The engine does not supply source fixes or declaration shims.

Libva uses its native Autotools build for static archives. Its driver search defaults to Debian's multiarch
directory on glibc and `/usr/lib/dri` on musl; set upstream's `LIBVA_DRIVERS_PATH` for another layout.
Static libva still loads the recipient's graphics driver dynamically. Actual hardware compatibility requires
testing with that driver.

On Linux x64, `libdrm`, `libva` and `libvpl` accept independent bundled `shared`
selections and retain static defaults. Shared VA includes both its core and DRM
libraries; oneVPL bundles its dispatcher. Neither mode supplies a hardware driver
or a physical device. Provide compatible VA drivers and use `LIBVA_DRIVERS_PATH`
when their directory differs from the build prefix. Distribution locations vary:
Debian/Ubuntu commonly use `/usr/lib/x86_64-linux-gnu/dri` and Fedora
`/usr/lib64/dri`. These are hints, not an ABI guarantee. oneVPL similarly needs a
compatible implementation such as the recipient's Intel GPU runtime.

The maintained checks cover invalid device descriptors and software output.
Native SDK checks exercise DRM containers, VA utility/invalid-display contracts,
and actual oneVPL loader dispatch through an upstream source-built test runtime.
They do not claim physical GPU encoding or decoding. CMake SDK consumers of
shared oneVPL must select its native `VPL_SHARED=ON` option.

On Linux x64, `shaderc` and `libplacebo` accept independent bundled `shared`
selections, with static defaults. Shaderc keeps its compiler dependencies embedded;
libplacebo receives the caller's Vulkan dispatch function and does not link another
loader. Either a static or shared caller loader is supported. The selected modes
do not embed a GPU driver: an installed compatible Vulkan ICD remains necessary.

FFmpeg 8 can also list `shaderc` directly for its Vulkan filters. FFmpeg 9 removed
that option and uses the host `glslc` compiler; shaderc remains libplacebo's runtime
compiler dependency. Its static pkg-config metadata includes both its C++ runtime
and math dependency so FFmpeg 8's direct configure probe can link independently.

Maintained lavapipe tests compare uploaded/rendered/downloaded frame pixels across
the static/shared combinations. Native SDK checks cover actual SPIR-V compilation,
include callbacks, cloned options, C++ wrappers and libplacebo public data. The
external `examples/canary/tests/vulkan-import.c` probe imports a caller-owned
device, destroys the wrapper, then submits and completes work on the original
device. This lifecycle was checked against all seven locally built archives,
including both caller loader modes; it does not claim physical GPU coverage.

On Linux x64, `opencl-icd-loader` and `lcevcdec` retain static defaults and offer
independent bundled `shared` modes. OpenCL stages its native versioned loader;
LCEVC stages both its API and CPU pipeline libraries, with private convenience
libraries and C++ runtime embedded. Existing library license gates are unchanged.

An OpenCL loader still needs a compatible vendor ICD. CPU-only FFmpeg operations
can run without one; OpenCL device creation reports that no platform is available.
The maintained runtime uses distro PoCL as a test-only CPU ICD and compares four
OpenCL-transposed frames byte for byte with the CPU transpose. External SDK checks
execute an owned integer kernel, validate events and build diagnostics, and release
every object. Shared mode retains upstream loader-managed dispatch and symbol
versions; it does not substitute a system loader or bundle a GPU driver.

LCEVC's native SDK tests pass four nonconstant I420 frames through the CPU pipeline
without enhancement data, checking timestamps, plane strides, output bytes and
picture ownership. FFmpeg's maintained filter test likewise checks complete EOF
and exact passthrough pixels. This verifies CPU passthrough, not enhancement-stream
decoding or GPU acceleration. Linux static SDK metadata includes pthread support.
DVD reading and navigation offer independent Linux x64 static and bundled shared choices:
`link: { libdvdread: shared, libdvdnav: shared }`. Static remains the default. Shared archives
include the native `libdvdread.so.8` and `libdvdnav.so.4` SDK/runtime libraries; either may be
selected separately. Both retain GPL-2.0-or-later licensing and opt-in `with: [dvdread, dvdnav]`.
Owned unencrypted ISO/folder tests cover full title reads, IFO metadata, navigation cache ownership,
chapter timing and FFmpeg playback to EOF. No decryption libraries or keys are bundled;
encrypted discs require separately installed system libdvdcss, loaded at runtime by upstream.
Physical drives, CSS and protected regions are not covered by these image tests.

Android x64 offers a bundled shared `cpu-features` choice, retaining the static
default. It bundles both native `libcpu_features.so` and `libndk_compat.so`;
Tesseract uses the latter's NDK compatibility API. Both follow Android's 16 KB
page-alignment requirement. Upstream has no versioned shared ABI and warns that
public feature bitfields depend on the compiler. Use headers built with the
same pinned NDK rather than treating these libraries as interchangeable system
packages. Android arm64 retains its existing static recipe.

Verification runs exact build-compiler SDK helpers on an Android emulator in
separate detection/setter processes, and uses an FFmpeg library consumer for
owned OCR text, unchanged pixels and filter EOF. The temporary verification
build carries those helpers; release packages do not contain test executables.
On Linux x64, Leptonica and Tesseract retain static defaults and offer bundled
`shared` selections. Shared Tesseract requires shared Leptonica: their full public
SDK transfers PIX ownership across the boundary, while Leptonica's custom pixel
allocator is held in library-global state. The planner rejects a private static
Leptonica inside shared Tesseract. Static Tesseract can use shared Leptonica, and
PNG/zlib dependencies keep their independently selected modes.

Shared Leptonica preserves its annotated public functions and data; shared
Tesseract preserves its C and C++ SDK, including renderer RTTI and virtual methods,
with a private static C++ runtime and the common system unwinder. Linux static SDK
metadata includes its thread dependency. Native SDK checks track custom pixel
allocations through ownership transfer, thresholded-image retention and destruction.

Language models are separate resources in either mode. Supply `datapath` or
`TESSDATA_PREFIX`; the maintained checks download and verify a pinned Apache-2.0
English model solely for testing. Six FFmpeg 8/9 combinations recognize an owned
text image and reject missing language data. External SDK checks also recognize
the text through C/C++ APIs and exercise iterators and a renderer subclass. No
training tools or language model is added to release archives.

Some libraries offer a verified choice of linking mode. A target or base can use `link: { libgcrypt: shared }`,
keyed by recipe name. Unspecified libraries keep their existing defaults; selecting a shared library does not
change its dependencies' modes. `ffmpeg-build plan` shows the resolved choices. At present, libgcrypt and
libgpg-error, zlib, xz (liblzma), aom, dav1d, soxr, libbs2b, libogg, libvorbis, opus, speex,
libmp3lame, shine, twolame, liblc3, libqrencode, openjpeg, libwebp, libvpx, zimg, snappy, freetype,
libpng, fribidi, harfbuzz, fontconfig, libass, libexpat, x264, openh264, xvidcore, x265, vvenc, svtav1,
libtheora, opencore-amr, vo-amrwbenc, libilbc, gmp, nettle, libtasn1, gnutls, pixman, openal-soft, sndio,
minizip-ng, yaml-cpp, pystring, imath, libvmaf, xavs, libssh, librtmp, opencolorio and opencv
offer static and bundled shared modes on Linux x64,
with static as their default. Shared libraries
are included beside FFmpeg; this setting does not link to an arbitrary system installation. Other recipes reject
linking overrides until a mode has been verified for them.

BS2B uses its untouched 3.1.0 release configuration on Linux x64 and ARM hard-float only, with libsndfile installed
for its native configure check. Its obsolete Automake inputs cannot be regenerated with the current tools, and its
distributed configuration scripts do not recognize the other target triples.

Libgcrypt uses its native `--disable-jent-support` option to omit the optional CPU-timing entropy collector,
whose generic symbols collide with static LibreSSL. Its OS-backed random generator and SHA3 algorithms remain
enabled; the build does not rename internal library functions.

Pango and librsvg offer bundled shared choices on Linux x64, retaining static defaults.
Shared Pango requires shared GLib, Cairo, Fontconfig and HarfBuzz: the native Pango
libraries exchange GObjects, cached font objects and HarfBuzz fonts across their
library boundaries. A private static HarfBuzz copy per Pango library failed the
font-destruction SDK test; one common shared copy passes. Shared librsvg requires
shared Pango, Cairo and GLib. The planner rejects incompatible selections.
FreeType remains independently selectable. Static upper libraries can consume
shared lower libraries. The full native three-library Pango and librsvg SDKs are
included; recipient fonts and Fontconfig configuration are still needed.
MPEG-H offers `link: { mpeghdec: shared }` on Linux x64, with static as its default.
The shared library preserves both decoder and UI-manager SDKs and isolates its
internal FDK symbols, including when FDK AAC is enabled in the same build.
Upstream does not version its shared ABI; the bundle retains its native
`libmpeghdec.so` SONAME. Keep it with the matching FFmpeg build. No system-provider mode is offered.
The existing nonfree license selection and advisory release warning still apply.
Whisper offers `link: { whisper.cpp: shared }` on Linux x64 while retaining its
static default. The complete native runtime includes Whisper, Parakeet, GGML,
GGML base and CPU libraries, plus GGML Vulkan when that backend is selected.
All belong to one coherent recipe mode; dynamic backend plugin loading remains
disabled. Linux uses the native shared Vulkan loader shipped by its recipe.
Private C++ code remains local to the owning library.
Models are supplied separately. Tests cover real Whisper model inference on CPU
and software Vulkan, GGML computation and GGUF metadata; no Parakeet inference
claim is made by the invalid-model SDK check.
On Windows x64, Whisper selects GGML's native API path without the optional power-throttling override because
the current GCC SDK lacks its types. This may affect scheduling performance; it does not lower FFmpeg's supported
Windows baseline. Windows ARM64 keeps the newer SDK's native path.

X11 libraries offer Linux x64 bundled shared modes, retaining static defaults.
Select `link: { libxcb: shared, libx11: shared, libxext: shared, libxv: shared }`
for a common shared X connection owner; `libxau` may be selected independently.
Shared X11 requires shared XCB, shared Xext requires shared X11, and shared Xv
requires shared Xext. Incompatible combinations fail during planning. Static
upper libraries may consume shared lower libraries. XCB ships its complete core
and 24-extension runtime; X11 includes X11-xcb. Existing license gates are unchanged.
Xlib still uses the recipient's `/usr/share/X11` locale/error/keysym data and has
no loadable internationalization modules. Authenticated Xvfb tests cover capture,
cursor, outline and authorization paths; its lack of XVideo adaptors limits xv
verification to display opening and a clean unavailable-adaptor error.

VDPAU remains headers-only. A common shared X11/XCB owner removes the earlier
connection-ownership obstacle, but a real libvdpau wrapper and vendor-device
creation still require separate verification. Selecting shared X11 alone does
not enable FFmpeg's VDPAU device creation.

Terminal libraries offer independent Linux x64 bundled shared choices:
`link: { ncurses: shared, libcaca: shared }`, retaining static defaults. Ncurses
includes the wide-character core, panel, menu and form libraries with native
SONAME 6; libcaca uses native SONAME 0. The terminfo database remains the
recipient's, using the existing search paths and `TERMINFO`/`TERMINFO_DIRS`
overrides. No GPM mouse daemon is acquired by the shared ncurses recipe.
Libcaca's compressed-file API uses the explicitly selected zlib dependency.
Shared libcaca may embed private static ncurses; its public canvas/display APIs
do not exchange curses handles. For curses interoperability, select both shared
and coordinate terminal ownership. Existing license gates are unchanged.

OpenAL Soft and sndio retain static defaults and independently accept bundled shared mode on Linux x64.
Their ALSA implementation keeps its own selection: static ALSA uses builtin plugins, while shared ALSA can
load the recipient's desktop plugins. Audio device access still requires the recipient's configured audio
system. sndio can connect to an external sndiod server or use its direct `rsnd/` ALSA backend; no server is bundled.
Shared ALSA uses one upstream plugin directory: Debian's multiarch directory on glibc, `/usr/lib/alsa-lib`
on musl. On another distribution, set `ALSA_PLUGIN_DIR` to its installed plugins directory, for example
`/usr/lib64/alsa-lib` on Fedora. The engine does not add a multi-directory plugin search patch.
For SFTP and RTMP, `link: { libssh: shared, librtmp: shared }` bundles the selected client libraries.
Their cryptographic dependencies keep their own linking modes. Linux x64 librtmp normalizes GnuTLS retry
and error results so TLS 1.3 post-handshake messages do not break RTMPS or bypass socket read timeouts.
The maintained checks use local SSH, RTMP and TLS servers; they do not require remote service credentials.
Blu-ray and UDF reading offer independent Linux x64 static and bundled shared
choices: `link: { libbluray: shared, libudfread: shared }`. Static remains the
default. The native `libbluray.so.4` and `libudfread.so.3` libraries retain their
LGPL-2.1-or-later licensing. XML metadata support uses the selected libxml2 closure;
embedded static XML/zlib/UDF dependencies stay private in the shared owner.
Owned unencrypted folder/ISO tests cover actual reads, metadata, EOF and seeks,
plus FFmpeg packet counts and decoded video/audio. AACS/BD+ libraries and keys
are not bundled; upstream can load separately installed system decryption
libraries. BD-J remains disabled. Physical drives and protected media are untested.
JPEG XL (`libjxl`), Brotli and Highway offer independent static and bundled shared choices on Linux x64.
All three default to static. Bundled JPEG XL includes its encoder/decoder, thread runner and CMS libraries;
the decoder-only upstream library is not installed. Shared JPEG XL retains the native system C++ runtime and
common system unwinder. Mixed choices preserve each dependency's selected mode. Maintained runtime
checks cover lossless RGB, alpha and true 16-bit pixels, multiple frames and threads, bounded lossy error,
and installed C/C++ SDKs, including Brotli compression/dictionaries and Highway vector dispatch.
ARIB caption libraries (`aribb24`, `libaribcaption`), Teletext (`zvbi`) and DeckLink ancillary data (`libklvanc`)
offer static and bundled shared choices on Linux x64, with static defaults. Shared libaribcaption retains its native
unversioned `libaribcaption.so` name and requires shared FreeType and Fontconfig because its native CMake find modules
do not supply their static dependency closure. Keep these libraries with the matching FFmpeg build. Its public C
and C++ APIs are preserved, including caller replacement allocators. Maintained
checks decode authored captions through FFmpeg and exercise native SDK text/rendering and ancillary roundtrips.
DeckLink hardware I/O still needs the recipient's Desktop Video driver and hardware. The combined canaries use
the existing nonfree classification because this group contains LGPLv3 and GPLv2-only code plus DeckLink's SDK;
individual options retain their existing license choices.
OpenCV's shared choice bundles its native core and imgproc modules together. OpenColorIO preserves its full
public C++ interface, including application-owned logging callbacks and virtual configuration proxies. Their
dependency choices remain independent: owned configuration archives, LUTs and morphology pixels are checked
with static and shared dependencies. Shared OpenColorIO retains its native system C++ runtime and common system
exception unwinder. Hiding compiler exception state would corrupt caller
exception counts; a partial private standard-library map also broke exit-time teardown. Private noncompiler
archives remain hidden. Other supported platforms retain their existing static recipes.
OpenColorIO is unavailable on the current Windows MinGW toolchains: its released source uses an MSVC-only stream
constructor. Linux, macOS and Android retain their native builds.
The same native C++ ABI boundary preserves caller-owned allocation in pystring, SRT, Rubber Band and
Tesseract. Maintained SDK checks exercise replacement new/delete with both static and dynamic C++ callers;
returned heap strings must belong to the caller's allocator. Tesseract's SDK also retains its independent
Leptonica pixel-allocation ownership check.

yaml-cpp, Imath and OpenMPT likewise preserve the native C++ runtime ABI in their Linux shared libraries.
SDK checks throw through public parser, stream and module APIs into both static and dynamic C++ callers,
checking typed catches, retained rethrows and exception counts during unwinding and after cleanup.

SOFA audio (`libmysofa`), stabilization (`vid.stab`) and lens correction (`lensfun`) offer independent static and
bundled shared choices on Linux x64, with static defaults. The SOFA sample databases and Lensfun lens database
remain excluded; callers provide those data files. Shared Lensfun preserves its C and C++ SDKs while keeping
embedded GLib symbols private. Its embedded C++ runtime retains the native public ABI and common system
unwinder, so application replacement new/delete also owns allocations inside Lensfun. Maintained SDK checks
verify this with both static and dynamic C++ callers. Native SONAMEs are `libmysofa.so.1`, `libvidstab.so.1.2` and
`liblensfun.so.2`. Maintained checks use authored HRTF impulses, lens calibration and translated video,
checking actual samples, pixels, frame counts and stabilization rather than only filter listings.

Linux x64 also supports `link: { bzip2: shared, libxml2: shared }`. Static remains their default;
zlib retains its own selected mode. bzip2 uses the stable 1.0 ABI, and libxml2's actual SONAME follows
its reviewed release rather than assuming a historical system-library name. Both shared libraries are bundled.

Mac Catalyst builds currently disable VideoToolbox: the supported FFmpeg releases reference an OpenGL ES
compatibility key unavailable to Catalyst. Software codecs remain available; the engine does not patch
FFmpeg to enable this framework. VideoToolbox remains available on macOS and iOS.

FFmpeg's `metal` option is unavailable in the current releases: its `yadif_videotoolbox` filter has an ownership
crash that needs an [upstream fix](https://github.com/FFmpeg/FFmpeg/commit/7f2e5cdd7c3ad502141c918bac13e2a31b4829c0).
It can return after a compatible upstream release passes runtime verification. The engine does not backport
the fix. Whisper's independent upstream Metal backend remains available on macOS.

ALSA defaults to static linking with builtin plugins and direct hardware access. Static ALSA disables external
plugins to avoid loading a second ALSA library into the same process. Desktop configurations that use PulseAudio
or PipeWire ALSA plugins should select `link: { alsa-lib: shared }`; the bundled `libasound.so.2` then loads the
system's plugins. Both modes read the recipient's ALSA configuration. Linux OpenAL links the selected ALSA
library, so its backend follows the same choice. Direct hardware capture still requires an audio device.

For a verified library, `link: { libgcrypt: system-shared }` builds a shared library but omits it from the
runtime archive. The destination machine must supply compatible libraries. `RUNTIME-DEPENDENCIES.json` in the
archive records the actual ELF library names and required symbol versions, plus best-effort package suggestions
for distributions we have checked. The recorded source build version is not a minimum package version.
Package suggestions do not block builds or releases and are not a cross-distribution compatibility guarantee.
Static remains the default; `shared` continues to bundle the selected libraries beside FFmpeg. Dependencies
keep their own selected modes, so select `system-shared` for each dependency you want the destination to supply.

Linux x64 also supports system providers for `zlib`, `xz`, `libogg`, `libvorbis`, `opus`, `speex` and `libexpat`.
The package hints were checked on Debian 12, Ubuntu 24.04 and Fedora 44, with real codec, compression and font
configuration runs against those distributions' libraries. Each library keeps its static default. A distribution's
shared library can load its own dependencies; selecting bundled Ogg alongside system Vorbis does not change how
the distribution built Vorbis. The receipt distinguishes the omitted reference build from the shipped binaries.

PulseAudio uses its native shared client, bundling `libpulse.so.0` and its private `libpulsecommon` beside FFmpeg.
Its upstream Meson build does not offer static clients. It connects to the recipient's PulseAudio or pipewire-pulse
server and reads that system's client configuration; server modules remain server-side. Native gettext support
uses libc on glibc and the source-built proxy-libintl dependency on musl.

OpenSSL, LibreSSL and mbedTLS default to static linking and offer bundled shared libraries on Linux x64.
Select one TLS backend per target; OpenSSL and LibreSSL use overlapping header and library names.
OpenSSL's shared mode embeds its legacy provider in libcrypto, so an application can activate it without a
separate provider-module directory. It does not activate legacy algorithms automatically. The shared mbedTLS
mode bundles its TLS, X.509 and crypto libraries together and retains pthread support.
Rubber Band, Chromaprint, XEVE and XEVD offer bundled shared libraries on Linux x64 and retain static defaults.
Rubber Band keeps its builtin FFT and resampler; Chromaprint keeps its compiled-in KissFFT backend. Both embed
their C++ runtimes and retain the common system unwinder; Rubber Band preserves native public C++ ABI preemption.
XEVE and XEVD are C libraries;
their encoder and decoder linking modes can be selected independently.
Codec2, Kvazaar, Xavs2 and Davs2 offer bundled shared libraries on Linux x64 while keeping static defaults.
Xavs2 and Davs2 remain GPL build options, and their linking modes can be selected independently. Shared Davs2
includes its private C++ runtime while retaining the common system unwinder.

JACK2 uses its native shared Linux client on glibc and needs a compatible JACK2 server. It can be replaced by
PipeWire's `pw-jack` through `LD_LIBRARY_PATH`; it never starts a server automatically. A static Linux client
requires changing upstream's Waf rules and is not offered. Its bundled Waf requires Python 3.11 or earlier
(the `imp` module). Current musl toolchain images ship a newer Python, so JACK2 is unavailable there.
The client uses the system's `libgcc_s.so.1` for thread cancellation and embeds its C++ runtime.

On Linux, `vulkan-loader` supports bundled shared linking only, matching upstream's build. A static Unix loader
requires changes to upstream's CMake target and is not offered. The shared loader requires an installed Vulkan ICD
driver; bundling the loader does not bundle a GPU driver. Whisper can use that loader without enabling FFmpeg's Vulkan
components unless the target also lists `vulkan`. The maintained runtime check uses Mesa lavapipe and explicitly
selects it for GGML, which normally excludes CPU Vulkan devices. This verifies API operation without claiming
physical GPU coverage.

On Linux x64, `glib`, `pcre2` and `libffi` default to static linking and accept independent `shared` selections.
Shared GLib bundles all six installed libraries, including GObject, GIO and GIRepository; shared PCRE2 includes
its POSIX wrapper. GLib's bundled GIO does not load distribution modules by default. Applications can supply
compatible modules explicitly through `GIO_MODULE_DIR` or `GIO_EXTRA_MODULES`, and typelibs through
`GI_TYPELIB_PATH` or the repository API. TLS modules, schemas and MIME databases are separate application or
system resources. Built-in GIO streams, files and compression need no extra modules. Installed SDK checks cover
GObject's generic libffi marshaller, callbacks, module loading and an authored GIRepository typelib.
On Linux x64, `libraw1394`, `libavc1394`, `libiec61883` and `libdc1394` default to static linking and accept
independent `shared` selections. The AV/C package includes both its AV/C and ROM libraries. Camera capture
and bus streaming require the recipient's FireWire controller, Linux driver and device permissions. Maintained
software checks exercise unbound handles, stream-object ownership, status/ROM decoding and exact pixel
conversion; device listing and clean failures without a controller do not establish hardware capture support.
On Linux x64, `libcdio` and `libcdio-paranoia` default to static linking and accept independent `shared`
selections. Shared CDIO includes its ISO9660 and UDF libraries; shared paranoia includes the CDDA interface.
The libraries can read compatible CUE/BIN audio images as well as supported drives. The maintained image
check verifies exact stereo samples with an explicit output bound, and the SDK checks verified reads,
seeking, filesystem contents and caller-owned handles without requiring an optical drive.

Little CMS, GSM, Game_Music_Emu and Flite also offer static and bundled shared modes on Linux x64.
Use their recipe names in `link`: `lcms2`, `libgsm`, `libgme` and `flite`. Static remains the default.
Flite bundles its core, language, lexicon and six native voice libraries; it does not require an audio server.
The published Flite release is unavailable on Windows with these toolchains: its native configure selects obsolete
compilers and its snprintf helper does not link under MinGW. Linux, Apple and Android keep their native builds.
Xvid is unavailable on Windows x64 with the current GCC producer: upstream configure cannot parse its
`13-win32` version string and retains the unsupported `-mno-cygwin` flag.
The GSM shared library is linked from the upstream PIC archive with the conventional `libgsm.so.1` name;
upstream itself supplies only a static archive. Game_Music_Emu keeps its default LGPL emulator and disables VGZ.

ModPlug, OpenMPT and libsndfile also offer static and bundled shared modes on Linux x64 through `libmodplug`,
`libopenmpt` and `libsndfile`. Static remains their default. The tracker libraries retain their installed C++ SDKs
and their existing format choices. libsndfile serves PulseAudio's native sample-upload API, which is retained
in the shared client closure even when an application only records or plays audio.

Shared ModPlug, OpenMPT, OpenColorIO and JPEG XL retain their native system C++ runtime dependency (`libstdc++.so.6` on Linux).
The recipient needs a compatible runtime, commonly `libstdc++6` on Debian/Ubuntu or `libstdc++` on Fedora.
These package names are suggestions; runtime compatibility still depends on the compiler and target system.
On Linux x64, the LV2 host libraries `lilv`, `serd`, `sord`, `sratom` and `zix` default to static linking and
accept independent `shared` selections. LV2 plugins are loaded as separate modules in either mode. Supply
compatible plugin bundles through `LV2_PATH` or the platform's usual LV2 folders. The maintained runtime check
authors its own gain plugin and verifies sample values, complete output and separate instances; installed SDK
checks also cover RDF parsing, typed atom serialization and indexed storage. LV2 itself supplies headers and
specifications and has no runtime linking choice.

A folder's `ffmpeg-build.yml` lists its builds. Each **target** is one build: one platform, one license, one FFmpeg
series, and the complete list of what it gets. **Bases** hold what several targets share; a target takes its bases
left to right, then its own lists. Nothing is added by itself, not by an engine release and not by a new FFmpeg
version, so a tight target (a streaming server's five libraries) stays tight.

```yaml
pin: # npm-style ranges, for every target that builds the library
  dav1d: '~1.5.4'
bases:
  streaming: { with: [dav1d, opus, srt, openssl] }
targets:
  linux-x64: # the name is also the build's: ffmpeg-<version>-linux-x64
    platform: linux-x64
    license: lgplv3 # lgplv2, lgplv3, gplv2, gplv3 or nonfree
    ffmpeg: 9 # 9, 9.0 or latest (the newest major: see below)
    base: [streaming]
    with: [vaapi] # by FFmpeg's own names
  linux-arm64:
    platform: linux-arm64
    license: lgplv3
    ffmpeg: 9
    base: [streaming]
    without: [opus] # turn down what a base gives; never suggested again
```

The editor schema is [`schema/ffmpeg-build.schema.json`](../schema/ffmpeg-build.schema.json); `init` starts the file
with a `# yaml-language-server: $schema=...` line, so editors with the YAML language server (VS Code's YAML extension,
for one) complete and check it. Add that line to a file you wrote by hand to get the same.

`with:` takes the options of [`ffmpeg/<major>.yml`](../ffmpeg/9.yml). Everything else FFmpeg's configure can turn on is
in [`ffmpeg/unsupported.yml`](../ffmpeg/unsupported.yml) with the reason it isn't built: most are still to come
(tracked in [issue #21](https://github.com/devenvy/ffmpeg-build/issues/21)), a few never will be (deprecated
upstream, or for a platform the engine doesn't build).

## Starting and editing

- **Start from the shipped targets.** You don't need to work out what each license allows on each platform yourself.
  [`profiles/devenvy.yml`](../profiles/devenvy.yml) is everything devenvy/ffmpeg publishes, one target per platform,
  license and FFmpeg series. `ffmpeg-build init --license <list> --platforms <list> [--ffmpeg <list>]` takes the
  targets you select (both lists are required; `all` takes every license or platform) and factors what they share into bases. `--empty` gives bare targets.
- **Edit with the helpers, or by hand.** Each helper keeps your comments and checks every target the edit reaches
  first: an edit that would give one a problem (x264 on an lgplv3 target) is refused, and nothing is written:

      ffmpeg-build profile add x265 srt --to gpl           # a base: every target using it
      ffmpeg-build profile add vaapi --to linux-x64        # one target
      ffmpeg-build profile remove opus --from linux-arm64  # a target turns down what its base gives it
      ffmpeg-build profile missing                         # what targets could add but don't list (exit 1 if any)

- **Look before you build.** `check` says whether every target is possible, `plan` what each builds,
  `show <target>` what one target gets and which base gave it, and `show --has <name>` which targets get something
  and why the others don't.

## Always the newest FFmpeg: `ffmpeg: latest`

`ffmpeg:` is a major (`9`: its newest release), a minor (`9.0`: its newest 9.0.x) or `latest`: the newest FFmpeg
major this engine supports. A base can say it too, for every target that takes the base and doesn't say its own (a
target's own `ffmpeg:` wins; otherwise the last of its bases that has one):

```yaml
bases:
  newest: { ffmpeg: latest }
targets:
  linux-x64: { platform: linux-x64, license: lgplv3, base: [newest, streaming] }
  win-x64: { platform: win-x64, license: lgplv3, base: [newest, streaming] }
  legacy: { platform: linux-x64, license: lgplv3, base: [newest, streaming], ffmpeg: 8 } # held back
```

- **What latest is.** The newest major with an `ffmpeg/<major>.yml` in the engine (added, with its component list,
  once someone has gone through that major's configure) that has a release upstream. A new FFmpeg major therefore
  reaches `latest` through an engine release, never straight from upstream.
- **The lock says which major.** `ffmpeg.lock` records the release `latest` stands for (`latest: 9.0.2`), so every
  build is reproducible and `lock` never moves it. `update` does: when the engine knows a newer major, the lock
  update's pull request moves every `latest` target to it (with the engine release that brought the major), and the
  lock's diff is the move (`latest: 9.0.2` -> `latest: 10.0.1`).
- **The PR says what it means.** Its text opens with `⚠ FFmpeg latest is now 10: a and b move from 9.0.2 to 10.0.1`,
  lists what `check` finds wrong with them on FFmpeg 10 (a `components:` name FFmpeg 10 doesn't have, a patch set
  without a `10/` folder or not declaring 10 in its `about.yml`, a `with:` FFmpeg 10 dropped) and what their releases
  would lose, and says how to stay: `ffmpeg: 9` on a target. `update` and `outdated` print the same on the terminal.
- **CI decides.** The move is one more change in the lock update's PR, which your CI checks like any other. The
  example `ci.yml` runs `check.yml`: `check` and `releases` stop it on everything the PR text lists. To stop it on
  the builds too (a patch that no longer applies fails the build, naming the patch and the file and line of the hunk
  that failed), `ffmpeg-build test` and your own tests, have the PR's CI call `build.yml` with `publish: never` and
  `due: true` ([CI](releases.md#ci-github-actions)); otherwise the release builds after the merge, and a failing
  build keeps that release a draft. Fix the folder on your default branch (add the `10/` patches, change the
  `components:`, or keep a target with `ffmpeg: 9`); the next update refreshes the PR. Automerge merges only a green
  PR; making CI's `result` a required check stops a merge by hand too.
- **When no lock fits.** If no lock can be chosen for the folder on the new major at all (a pin on a library no
  target builds any more there), `latest` stays where it is, the rest of the update goes ahead, and the PR text and
  `update-lock.yml`'s run say why (`FFmpeg latest stays on 9: on FFmpeg 10.0.1, pin ...`), every run until it's fixed.
- **Releases.** A release is one release group at one FFmpeg version, so `latest` targets moving to 10 make new
  releases, tagged `10.x.y.<build>`, and the group's 9.x releases stay as they were. The first release on the new
  major is judged against the group's last release on the old one: a library it no longer has stops it unless
  `allow-removal:` says so.

## Some targets at a time, and where they build

One file holds every build; a run can take some of them. `build`, `test`, `check`, `plan`, `targets` and `releases`
take `--target a,b` (names) and `--platform 'linux-*,win-x64'` (platform patterns, as the file writes them); both
together mean targets that match both. `build` builds each chosen target in turn:

    ffmpeg-build build --platform 'osx-*,ios-*,maccatalyst-*'   # on the Mac
    ffmpeg-build build --platform 'linux-*,win-*'               # on the Linux box

The optional `build:` section says where (a CI `runner`: a GitHub `runs-on` label, or a list of labels) and how
(`in: docker`, the pinned image; `in: here`, natively on that machine) a platform's targets build. Keys are platform
patterns; later entries override earlier ones, key by key. Without it, each platform builds where and how
`platforms.yml` says: Linux, Windows and Android in Docker on Linux runners, Apple natively on macOS runners.

```yaml
build:
  win-*: { runner: windows-2025, in: here } # native Windows builds on a Windows runner
  osx-*: { runner: [self-hosted, macOS, ARM64] } # your own Mac
```

- `check` refuses what can't work, before anything builds: Apple off a Mac or in Docker, Docker off Linux, `here` for
  another machine than the runner (`in: here` is for linux-x64, linux-arm64, win-* and Apple). A runner label it
  can't read (most self-hosted ones) is trusted, and `check` says so.
- A native build depends on its machine, so `in: here` and its runner are part of the target's toolchain: changing
  them makes its release due, and its libraries are cached apart. A Docker build is the same wherever it runs.
- A release is published with all its targets. Builds that come from somewhere else (another machine, another
  workflow) get their own `release-group:`, so they are their own release.

## Older Android: `android-api`

An Android build is compiled for API level 28 (Android 9): the oldest Android its libraries load on. An app with a
lower `minSdk` sets the level on its android targets, from 21 to 35:

```yaml
targets:
  android-arm64:
    platform: android-arm64
    license: lgplv3
    ffmpeg: 9
    with: [dav1d, opus, mediacodec, jni]
    android-api: 24 # loads on Android 7.0+
```

- **What can't go lower.** Some options and libraries need Android 9's APIs, and `check` refuses a target that has one
  and a lower level, naming it: `iconv` (Bionic's iconv is API 28's), `whisper` (whisper.cpp links Android's Vulkan
  1.1 library directly), and `vulkan` and `placebo` (they build for any level, but FFmpeg's Vulkan needs a Vulkan 1.3
  device, and Android has Vulkan 1.1 only from Android 9). Their `android-api:` in
  [`ffmpeg/<major>.yml`](../ffmpeg/9.yml) and the recipes says so.
- **iconv.** FFmpeg finds the C library's iconv by itself on Android 9 and up, whether or not a target lists `iconv`;
  a build for an older level has none (no `-sub_charenc`).
- **What it changes.** The NDK's compilers for that level build FFmpeg and every library (`aarch64-linux-android24-clang`,
  CMake's `ANDROID_PLATFORM=android-24`), and `ffmpeg-build test` links its smoke program for that level, so a library
  that calls what that Android lacks fails the link. The libraries are cached per level, and setting `android-api:`
  makes the target's release due. Leaving it out keeps 28, and the build it always had.
- **What CI runs.** The tests run the build on an Android 15 emulator; a level below 28 is checked by the compile and
  that link, not on an old Android.

## Slimmer builds: components

`with:` picks libraries. FFmpeg's own components (its built-in decoders, encoders, demuxers, muxers, parsers,
bitstream filters, protocols, devices and filters) are all built unless a target says otherwise. `components:` says
otherwise, kind by kind: a kind it lists is built with only those names, and what comes with them; a kind it leaves out
keeps FFmpeg's defaults. Leave `components:` out and nothing changes.

```yaml
bases:
  slim: # what every platform's services use, and what `ffmpeg-build test` needs (wrapped_avframe, null, testsrc2)
    components:
      decoders: [h264, hevc, aac, pcm_s16le, mjpeg, wrapped_avframe]
      encoders: [aac, mjpeg, wrapped_avframe]
      demuxers: [mov, matroska, mpegts, rtsp]
      muxers: [mp4, matroska, mpegts, image2, null]
      filters: [scale, fps, aresample, testsrc2]
      protocols: [file, pipe, tcp, udp, rtp]
targets:
  linux-x64:
    platform: linux-x64
    license: gplv3
    ffmpeg: 9
    base: [slim]
    with: [x264, vpx, vaapi, nvenc, whisper] # libx264, libvpx_vp8/vp9, the VAAPI and NVENC encoders, whisper come along
    patches: [patches/acme-format] # and the demuxer, muxer and codec it adds
  win-x64:
    platform: win-x64
    license: gplv3
    ffmpeg: 9
    base: [slim]
    with: [x264, mediafoundation, amf, d3d11va]
    components:
      filters: { add: [drawbox] } # the base's filters, and drawbox
```

- **Kinds:** `decoders`, `encoders`, `hwaccels`, `demuxers`, `muxers`, `parsers`, `bsfs`, `protocols`, `indevs`,
  `outdevs`, `filters`. **Names are configure's**, as `./configure --list-decoders` (and the rest) lists them, and as
  the engine keeps them in `ffmpeg/components/<major>.yml`. Most are what `ffmpeg -decoders` lists too; where a build
  lists a component by another name (configure's `libvpx_vp8` is `libvpx` in `ffmpeg -encoders`, the `pcm_s16le`
  demuxer is `s16le`, the `libsrt` protocol is `srt`), `check` says which name to write.
- **What the target's options need comes along.** For the options that are the components they bring (the codec
  libraries, the hardware APIs, whisper: the major's `auto-components:` in `ffmpeg/<major>.yml`), every component of a
  listed kind that needs the option stays: `vaapi` keeps `h264_vaapi`, `hevc_vaapi`, `av1_vaapi`, the VAAPI hwaccels
  and filters; `nvenc` the NVENC encoders, NVDEC hwaccels and CUVID decoders; `vpx` `libvpx_vp8` and `libvpx_vp9`. What
  needs what is configure's own rules, read from each release (`needs:` in `ffmpeg/components/<major>.yml`; that includes
  its licence switches: a GPL-only filter comes only in a gpl build). A support
  library brings nothing by itself: with `zlib` on, list `png` if you want it; with `openssl`, list `https` and `tls`;
  with `xml2`, `dash`. FFmpeg's configure then brings in what each component it builds depends on (the parsers and
  bitstream filters a decoder or muxer uses).
- **What the target's patch sets add comes along**, as each set's `about.yml` declares it (`adds:`, under Patches).
- **Checked.** `check` refuses a name FFmpeg doesn't have in that major (or that no patch set of the target adds), and
  a component whose option isn't on: `libx264 comes with x264: add x264 to with:`,
  `https comes with gnutls or openssl: add one of them to with:`. `test` fails a build missing any decoder, encoder,
  demuxer, muxer, protocol or filter configure was asked for by name, the listed ones and what came along, looked for by
  the name the build lists it under. (`-hwaccels` lists device types, not hwaccels, so those are configure's to check.)
- **What `test` needs.** `ffmpeg-build test` (which `build.yml` runs on every build) encodes a test pattern with the
  ffmpeg program: `ffmpeg -f lavfi -i testsrc2 -f null -`. That needs the `lavfi` input device, the `testsrc2` filter,
  `wrapped_avframe` as decoder and encoder, and the `null` muxer, so for a build with programs (not Android, iOS or Mac
  Catalyst, whose test links a program against the libraries instead), `check` refuses a `components:` kind that lists
  names but leaves its one out: `components: encoders: add wrapped_avframe`. A library build's smoke program needs
  nothing of `components:`: it round-trips a frame with a codec the build has (none, for a decode-only build) and
  checks only what the configure line says the build has ([building](building.md)).
- **Layers.** A target takes each kind from the last of its bases and itself that lists it: a list replaces the one
  before it. `{ add: [drawbox] }` adds to the list the layers before it gave instead; with no list before it, it is
  refused (it would quietly make the kind just those names).
- **Releases.** Changing a target's `components:` makes its release due (its definition changed).

## Patches

A target can carry your own changes to FFmpeg: `patches:` names patch sets, each a folder inside the build folder
(the one holding `ffmpeg-build.yml`; a path outside it is refused, because the folder goes into the release's sources
archive at the same path).

```
ffmpeg-build.yml
patches/
  acme-muxer/
    about.yml          # what the set is, and its licence
    LICENSE            # the licence text the archives carry
    9/                 # the patches for FFmpeg 9
      0001-add-acme-muxer.patch
      0002-acme-muxer-docs.patch
    10/                # and for FFmpeg 10, when the set supports it
      0001-add-acme-muxer.patch
```

```yaml
# patches/acme-muxer/about.yml
name: acme-muxer
license: proprietary # SPDX, or proprietary; licenses.yml says which build licenses it may go into
license-files: [LICENSE] # at least one, relative to this folder
ffmpeg: [9, 10] # the FFmpeg majors it has patches for (a major, or a list of them)
adds: # the components the patches add, by kind, as configure names them (optional)
  demuxers: [acme]
  muxers: [acme]
  decoders: [adpcm_acme]
  encoders: [{ adpcm_acme: { listed-as: acme_adpcm } }] # the build lists it as acme_adpcm (its .p.name)
  filters: [acme_drawbox]
```

```yaml
# ffmpeg-build.yml
targets:
  linux-x64-nonfree:
    platform: linux-x64
    license: nonfree # a proprietary patch set can only go into nonfree builds
    ffmpeg: 9
    patches: [patches/acme-muxer]
```

- **Applying.** Before FFmpeg is configured, each set the target names (in the order `patches:` lists them) has the
  `.patch` and `.diff` files of its `<major>/` folder applied to FFmpeg's source, in name order, with
  `git apply -p1` (so `git format-patch` output works as it is). A patch that doesn't apply stops the build, naming the
  set and the file: update it for that FFmpeg version.
- **Checked first.** `check` refuses a set without `about.yml` or with a malformed one, a licence file that isn't
  there, an `ffmpeg:` entry that isn't a major (`9`, not `9.1`), a licence the target's license doesn't allow (the
  same table as libraries), a major the target builds that `ffmpeg:` doesn't list, and a listed major without its
  `<major>/` folder. `about.yml` may also hold `configure:`, FFmpeg configure flags what the patches add needs: they
  go on the configure line of every target that uses the set, after the target's own.
- **What a set adds.** `adds:` names the components the patches add, kind by kind, in configure's spelling (a
  component `ff_acme_demuxer` in `libavformat/allformats.c` is the demuxer `acme`). A target applying the set may list
  them in `components:`, and they are built whatever its lists say: in a kind it restricts they join its list, and in
  one it doesn't they are still asked for by name. `test` then checks each is in the build, by the name the build lists
  it under: configure's, or the entry's `listed-as:` (the definition's `.p.name`, when it differs). `check` refuses an
  addition stock FFmpeg already has in that major.
- **Recorded.** `THIRD-PARTY-NOTICES.txt` says FFmpeg was modified, lists each set with its patches and a sha256 of
  the whole set, and carries each set's licence texts in a PATCH SETS section; its source section points at the
  sources archive, which holds the patch set folders beside `ffmpeg-build.yml` and `ffmpeg.lock`.
  `<name>.sources.json` and the release's `manifest.yml` record each set's name and sha256.
- **Releases.** Changing anything in a set (a patch, `about.yml`, a licence file, any major's folder) makes the
  releases of the targets using it due, and `bundle` refuses a build made with other patches than the folder has now.

## Tests

Rockchip MPP retains static defaults and offers a bundled shared choice on Linux ARM64.
Its native MPP and legacy VPU libraries ship together, preserving SONAME1 and their
upstream VERSION0 filenames. SDK checks exercise frames, packets and imported
caller-owned buffers without a device. Actual decoding and encoding require
a supported Rockchip SoC and kernel driver.

V4L libraries retain static defaults and offer a bundled shared choice on Linux x64
through `link: { v4l-utils: shared }`. On Linux x64 both modes ship the independent
`ov511-decomp` and `ov518-decomp` decoder programs beside the runtime; their GPL-2.0-only
and BSD-2-Clause notices are included separately from the LGPL-linked libraries.
Upstream's fork/pipe protocol remains intact. Owner-relative paths replace the
build-machine paths, including when the library is embedded statically inside FFmpeg.
Other platforms retain their existing static behavior. Software conversion fixtures
exercise both helpers, but physical V4L camera capture remains untested.

On macOS arm64, Vulkan can link the native MoltenVK archive directly into FFmpeg,
without a separate loader or ICD manifest. This is the static default. To bundle
the Khronos loader and native MoltenVK driver instead, select
`link: { vulkan-loader: shared, moltenvk: shared }`; both owners must use the
same mode on macOS. Other Apple platforms retain their existing modes. Whisper
continues to use its Metal and Accelerate backend on macOS.

`tests:` lists scripts in the folder that `ffmpeg-build test` runs against the build, after its own smoke test, with
`FFMPEG`, `FFPROBE` and `FFMPEG_DIR` set ([testing a build](building.md#testing-a-build); not for Android, iOS and
Mac Catalyst builds, which have no programs). A script that needs a secret (a key to decrypt a sample, a token)
names the variable in `test-env:`, and gets it only there:

```yaml
targets:
  linux-x64:
    platform: linux-x64
    license: lgplv3
    ffmpeg: 9
    with: [dav1d]
    tests: [tests/decrypt.sh]
    test-env: [DECRYPT_KEY] # the variables its tests: get; build.yml's test-env secret gives the values
```

In CI the values come from `build.yml`'s `test-env` secret; locally, from your environment
(`DECRYPT_KEY=... ffmpeg-build test --target linux-x64`). How it is passed, and what a run without secrets does:
[tests that need a secret](building.md#tests-that-need-a-secret).

## Rules

VMAF is unavailable on Windows ARM64 with this toolchain: upstream libsvm fails to compile against its libc++.
Other VMAF platforms keep their existing linking choices. The engine does not rename upstream source symbols.

SRT, librist, ZeroMQ and RabbitMQ-C offer static and bundled shared modes on
Linux x64, keyed by `srt`, `librist`, `libzmq` and `rabbitmq-c`. Static remains
the default. SRT's installed C++ SDK preserves native compiler ABI preemption
while its C++ runtime is embedded in the library; ZeroMQ retains its installed C API. The
common system unwinder remains shared for thread cancellation. SRT and librist
use the selected pinned mbedTLS where the target's license permits it;
other targets retain clear transport. RabbitMQ-C retains its existing plain
AMQP support. The canary tests use isolated local peers and a disposable broker.
FDK-AAC, OpenAPV, SVT-JPEG-XS and Quirc offer static and bundled shared modes on
Linux x64, keyed by `fdk-aac`, `oapv`, `svt-jpegxs` and `quirc`. Static remains
the default. The shared FDK library preserves its complete installed C SDK while
keeping internal DSP symbols private; it also works beside the independently
prefixed MPEG-H decoder. OpenAPV retains the supported 0.x API. Quirc's bundled
library uses an engine-defined full-version SONAME (`libquirc.so.1.2` for 1.2);
this makes no compatibility promise about separately installed distro libraries.
These choices use the same existing license checks as their static versions.
`link: { uavs3d: shared }` bundles the AVS3 decoder on Linux x64. Static remains
the default. The shared library exposes the complete installed C SDK while
keeping internal dispatch symbols private. It retains the native unversioned
`libuavs3d.so` name; keep it with the matching FFmpeg build. Static and shared
canaries decode an authored eight-frame stream with one and two threads,
requiring exact agreement with the encoder's reconstruction through EOF.
Upstream writes a decoder-creation diagnostic to stdout. Use file output with this decoder; its binary stdout
streams contain that diagnostic and are unsuitable for media piping.
Android ARM64 uses upstream's NDK build and supports 8-bit streams only. Other supported platforms use its
native 10-bit CMake configuration, which also decodes 8-bit streams. Generic Android x64 is unavailable because
the native NDK configuration forces an AVX2 CPU baseline.

- **Saying no is explicit.** `without:` turns something down for good: `profile missing` and the update PR text stop
  suggesting it.
- **Licenses are checked, never guessed.** An option whose library a target's license doesn't allow is an error that
  says which licenses would allow it. Which licenses each library may go into is in
  [`licenses.yml`](../licenses.yml): an SPDX table, applied to the library and everything it needs. Optional pieces
  are built in only where their license allows, and `check` says where they are left out (SRT's encryption uses
  mbedTLS, which lgplv2 builds can't take).
- **One version per library.** `ffmpeg.lock` holds one FFmpeg release per series and one version per library for the
  whole folder. Pins (`pin:` at the top for every target, or on a target) are constraints the chosen version must
  meet, all of them. Pins use npm's range syntax: `"4.3"`, `"~1.5.4"`, `"^1.5.4"`, `">=3.6 <4"`; a library that
  follows a branch is pinned to a full commit hash.
- **The lock pins content, not just versions.** Beside each version, `ffmpeg.lock` records what it stands for: a
  library released as git tags gets the full commit its tag names (`git ls-remote`, through an annotated tag), and a
  tarball (FFmpeg's own too) its sha256. A library that follows a branch needs nothing more: its version is a commit.
  `lock` downloads each tarball once to hash it, into the build cache's `sources/` (`FFMPEG_BUILD_CACHE`), so the
  build doesn't download it again. A pin is kept as long as its version is; `update` pins each version it moves to.

  ```yaml
  ffmpeg:
    '9':
      { version: 9.0.2, sha256: 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e }
  libraries:
    dav1d: { version: 1.5.4, commit: 54706fc6bc0cdecab7e9593974a4039cc038fca7 }
    gmp:
      { version: 6.3.0, sha256: a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898 }
    x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55 # follows a branch: the version is the commit
  ```

  A build fetches by the version, then checks: a git checkout must be at the pinned commit, and a tarball, from any
  mirror, must have the pinned sha256 before it is unpacked. Anything else stops the build with the library, the pin
  and what came instead (a mirror whose archive differs is passed over for the next; FFmpeg's fallbacks are copies of
  ffmpeg.org's own tarball, so they can stand in for it).
  A cached library built from other content than the pin is built again. A lock written before pins (versions only)
  still builds, unchecked, and `check` notes `run ffmpeg-build lock to pin sources`; `lock` adds the pins without
  moving a version.

- **New FFmpeg versions.** When `update` moves to a new FFmpeg minor, the PR text lists what it adds and which
  targets don't list it. When a new major is out and targets name an older one, it says so (`notify: { new-ffmpeg:
false }` turns that off): in the PR text, on stderr, and, in `update-lock.yml`, as a warning on every run until the
  folder builds it, even when the lock didn't change and there is no PR. You decide; nothing is opted in, except by
  `ffmpeg: latest`, which follows new majors by itself ([above](#always-the-newest-ffmpeg-ffmpeg-latest)).
- **Versions come from upstream.** `lock`, `outdated` and `update` read upstream git tags, branches and release
  pages (they need `git` on PATH, and no API tokens).

## Old matrix profiles

Before targets, a profile was one file with `platforms:` and `license:` lists and conditional entries.
`ffmpeg-build migrate` turns a folder of them, and its lock, into `ffmpeg-build.yml` and one lock that build exactly
the same, with the same asset names. The old files are kept as `*.old`. Every other command in such a folder says to
run `migrate`.
