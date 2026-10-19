# The linux-musl-arm64 toolchain image: upstream devenvy/ffmpeg's pinned Alpine (musl libc) for arm64, provisioned
# with the packages upstream's 03_install_packages.sh installs for musl on arm64 (no nasm/yasm: x86 assemblers).
# An arm64 image: it runs natively on an arm64 host and under qemu on an x64 one, as upstream builds it on arm64
# runners. Artifacts link libgcc and libstdc++ statically, so they run on any musl system. The library cache keys on
# this image's Docker ID.
FROM --platform=linux/arm64 mirror.gcr.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS toolchain
FROM --platform=linux/arm64 mirror.gcr.io/library/node:24.20.0-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca AS node
FROM --platform=linux/arm64 mirror.gcr.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
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
