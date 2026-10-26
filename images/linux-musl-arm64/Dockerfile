# The linux-musl-arm64 toolchain image: upstream devenvy/ffmpeg's pinned Alpine (musl libc) for arm64, provisioned
# with the packages upstream's 03_install_packages.sh installs for musl on arm64 (no nasm/yasm: x86 assemblers).
# An arm64 image: it runs natively on an arm64 host and under qemu on an x64 one, as upstream builds it on arm64
# runners. Artifacts link libgcc and libstdc++ statically, so they run on any musl system. The library cache keys on
# this image's Docker ID.
FROM --platform=linux/arm64 mirror.gcr.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS toolchain
FROM --platform=linux/arm64 mirror.gcr.io/library/node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2 AS node
FROM --platform=linux/arm64 mirror.gcr.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
COPY --from=node /usr/local/ /usr/local/

# bash, jq and GNU findutils/coreutils/tar/sed/grep for the driver (BusyBox lacks find -printf and friends);
# xxd for libvmaf's built-in models; python3 for meson. Alpine's own glslc is new enough (probed below).
RUN apk add --no-cache \
      bash autoconf automake libtool build-base cmake curl diffutils gperf git linux-headers m4 meson ninja \
      patchelf perl pkgconf xz xxd glslang shaderc jq python3 tar findutils coreutils sed grep

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
RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/aarch64-unknown-linux-musl/rustup-init \
 && echo '1ddf36182ac5d1782dbeefcb9bea7f5f9412d88f4a0d5047b1564a223624e8c6  /tmp/rustup-init' | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.1 \
 && rm /tmp/rustup-init \
 && curl -fsSL -o /tmp/cargo-c.tgz https://github.com/lu-zero/cargo-c/releases/download/v0.10.26/cargo-c-aarch64-unknown-linux-musl.tar.gz \
 && echo '68a45c967438240b64f2806639098c89df676c0152e855f5122cf5173204ce6c  /tmp/cargo-c.tgz' | sha256sum -c - \
 && tar -xzf /tmp/cargo-c.tgz -C /opt/cargo/bin \
 && rm /tmp/cargo-c.tgz \
 && rustc --version && cargo cinstall --version
