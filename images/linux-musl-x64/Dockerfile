# The linux-musl-x64 toolchain image: upstream devenvy/ffmpeg's pinned Alpine (musl libc), provisioned with the
# packages upstream's 03_install_packages.sh installs for musl. Artifacts link libgcc and libstdc++ statically, so
# they run on any musl system. The library cache keys on this image's Docker ID.
FROM mirror.gcr.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS toolchain
RUN apk add --no-cache gettext-dev
FROM mirror.gcr.io/library/node:24.20.0-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca AS node
FROM mirror.gcr.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
COPY --from=node /usr/local/ /usr/local/
# Bootstrap data only: gettext-dev's GNU header conflicts with musl's native gettext implementation.
COPY --from=toolchain /usr/share/gettext/ /usr/share/gettext/
COPY --from=toolchain /usr/share/aclocal/nls.m4 /usr/share/aclocal/nls.m4

# bash, jq and GNU findutils/coreutils/tar/sed/grep for the driver (BusyBox lacks find -printf and friends);
# xxd for libvmaf's built-in models; python3 for meson. Alpine's own glslc is new enough (probed below).
RUN apk add --no-cache \
      bash autoconf automake libtool gettext musl-libintl llvm-libunwind-static build-base cmake curl diffutils gperf git linux-headers m4 meson nasm ninja \
      patchelf perl pkgconf xz yasm xxd glslang shaderc jq python3 tar findutils coreutils sed grep
RUN autopoint --version \
 && apk info --who-owns /usr/lib/libunwind.a \
 && test -s /usr/lib/libunwind.a && test ! -e /usr/lib/libunwind.so \
 && test -s /usr/share/gettext/archive.dir.tar.xz \
 && printf '#include <libintl.h>\nint main(void) { bindtextdomain("ffb", "."); return dgettext("ffb", "ok") == 0; }\n' | cc -x c - -o /tmp/gettext-probe \
 && /tmp/gettext-probe && rm -f /tmp/gettext-probe

# FFmpeg 8.1+ / 9.x probe the shader compiler with Vulkan 1.4 / SPIR-V 1.6; a glslc that predates Vulkan 1.4 makes
# configure drop every Vulkan filter silently. The image fails to build rather than produce such builds.
RUN printf '#version 460\nvoid main() {}\n' > /tmp/probe.comp \
 && glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460 -c /tmp/probe.comp -o /tmp/probe.spv \
 && rm -f /tmp/probe.comp /tmp/probe.spv

# clang for FFmpeg's cuda-llvm option: it compiles the CUDA filters' kernels to PTX (NVIDIA's nvcc is nonfree). Only
# FFmpeg's configure calls it (as its nvcc); the libraries' builds still find gcc as cc. Probed as configure probes it,
# so an image whose clang can't emit PTX doesn't build.
RUN apk add --no-cache clang \
 && printf '#define __global__ __attribute__((global))\nextern "C" { __global__ void probe(unsigned char *data) {} }\n' > /tmp/probe.cu \
 && clang --cuda-gpu-arch=sm_30 -O2 -std=c++11 -m64 -S -nocudalib -nocudainc --cuda-device-only /tmp/probe.cu -o /tmp/probe.ptx \
 && grep -q '^.target sm_30' /tmp/probe.ptx \
 && rm -f /tmp/probe.cu /tmp/probe.ptx

# Rust and cargo-c for rav1e (FFmpeg's librav1e: a Rust library whose C API and static library cargo-c builds).
# rustup-init 1.29.1 by sha256, as static.rust-lang.org lists it; Rust 1.98.1 by version (rustup checks each
# component it downloads against that release's manifest); cargo-c 0.10.26's static musl build by sha256, as its
# GitHub release lists it. In /opt, on PATH.
ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:${PATH}
RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-musl/rustup-init \
 && echo '331228566cc931f32cd684f9bebc5956a5e5d7394c8d5de595f196a658ab98e6  /tmp/rustup-init' | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.1 \
 && rm /tmp/rustup-init \
 && curl -fsSL -o /tmp/cargo-c.tgz https://github.com/lu-zero/cargo-c/releases/download/v0.10.26/cargo-c-x86_64-unknown-linux-musl.tar.gz \
 && echo '685fab5a2e1539c5075cea21c42469ee5a489d877dbdbf7adccf4bb631d77545  /tmp/cargo-c.tgz' | sha256sum -c - \
 && tar -xzf /tmp/cargo-c.tgz -C /opt/cargo/bin \
 && rm /tmp/cargo-c.tgz \
 && rustc --version && cargo cinstall --version
