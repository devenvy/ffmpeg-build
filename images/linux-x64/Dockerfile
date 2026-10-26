# The linux-x64 toolchain image: upstream devenvy/ffmpeg's pinned manylinux_2_28 (AlmaLinux 8, glibc 2.28, so the
# artifacts run on any glibc >= 2.28), provisioned the way upstream's 03_install_packages.sh provisions it.
# Builds use gcc-toolset-14, which the driver enables. The library cache keys on this image's Docker ID.
FROM quay.io/pypa/manylinux_2_28_x86_64:2026.10.25-1@sha256:e2808351a165aa85913d79f1f8457b4f6d74047b47fba07b5b9a5e6c0055a017 AS toolchain
FROM mirror.gcr.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM quay.io/pypa/manylinux_2_28_x86_64:2026.10.25-1@sha256:e2808351a165aa85913d79f1f8457b4f6d74047b47fba07b5b9a5e6c0055a017
COPY --from=node /usr/local/ /usr/local/

# vim-common supplies xxd (libvmaf's built-in models silently vanish without it).
RUN dnf -y install --setopt=install_weak_deps=False \
      nasm cmake git pkgconfig autoconf automake libtool perl gperf xz bzip2 curl make diffutils gcc-c++ jq vim-common \
 && dnf clean all
# meson/ninja: the system python is 3.6 (pip caps meson at 0.61) and dnf's meson is 0.58, below libdrm's >= 0.59.
# meson and ninja by version and by sha256, as PyPI lists them: meson's one wheel, ninja's manylinux x86_64 and
# aarch64 wheels (--only-binary: never an sdist, whose build would run code no hash covers).
COPY <<'EOF' /tmp/meson-requirements.txt
meson==1.12.1 --hash=sha256:930bc7542cbd9f57009e182fd014eba48cf1a0180a7b9006d2d32d8f168d8b02
ninja==1.13.2 --hash=sha256:65a24341b5ac09fcadcc37082660be40a94174e51a937fabf6e2cae26225fa2c --hash=sha256:d775a5e43e9088f507a6250d57fcf5678eb31268c545feb5064ffeee33735622
EOF
RUN /opt/python/cp312-cp312/bin/pip install --no-cache-dir --require-hashes --only-binary :all: -r /tmp/meson-requirements.txt \
 && ln -sf /opt/python/cp312-cp312/bin/meson /usr/local/bin/meson \
 && ln -sf /opt/python/cp312-cp312/bin/ninja /usr/local/bin/ninja
# patchelf 0.19.2, static: AlmaLinux 8's 0.17.2 corrupts gcc-toolset PIE executables on --set-rpath '$ORIGIN'
# (CET/GNU_PROPERTY notes), and the staged ffmpeg then segfaults in the loader. SHA-256 as GitHub lists the asset.
RUN curl -fsSL -o /tmp/pe.tgz https://github.com/NixOS/patchelf/releases/download/0.19.2/patchelf-0.19.2-x86_64.tar.gz \
 && echo '2abdc34fbe949c995a1baa4ec310896a085588a45a99cd0d726851bdfac2a4bb  /tmp/pe.tgz' | sha256sum -c - \
 && tar -xzf /tmp/pe.tgz -C /tmp \
 && install -m755 /tmp/bin/patchelf /usr/local/bin/patchelf \
 && rm -rf /tmp/pe.tgz /tmp/bin

# glslc (Vulkan shader compiler) from the pinned shaderc -- AlmaLinux 8 has no package, and FFmpeg's Vulkan filters
# and whisper's ggml-vulkan shaders need it at build time. Upstream 03_install_packages.sh builds it the same way.
# "Is glslc present" is the WRONG question -- it has to be new enough. FFmpeg 8.1+ and 9.x probe the shader compiler
# with `glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460`; a glslc that predates Vulkan 1.4 rejects it,
# configure disables spirv_compiler and silently drops EVERY Vulkan filter. So the probe below is a build-time
# assertion: an image whose glslc cannot do it does not build.
# Pinned to the commit of the same shaderc tag as the shaderc recipe's locked version (devenvy deps.json
# .defaults.shaderc), and HEAD checked against it, since a tag can move: an
# unpinned clone tracked shaderc master and git-sync-deps pulled glslang/SPIRV-Tools HEAD -- a glslang change made
# spirv-opt emit LocalSizeId, which whisper's ggml-vulkan shaders (--target-env=vulkan1.2) reject.
# utils/git-sync-deps clones in worker threads whose failures never reach its exit status, so every DEPS entry is
# verified on disk at its pinned revision (as upstream's shaderc_sync_deps does) and the sync retried until it is.
# shaderc v2026.4: git ls-remote https://github.com/google/shaderc 'refs/tags/v2026.4^{}'
ARG SHADERC_COMMIT=b64fd42c4a2a9d501c47aca5d3571f7673a5e9cc
RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
src="$(mktemp -d)"
for n in 1 2 3 4 5 6; do
  { git init -q "${src}" && git -C "${src}" fetch -q --depth 1 https://github.com/google/shaderc "${SHADERC_COMMIT}" \
      && git -C "${src}" checkout -q FETCH_HEAD; } && break
  [ "${n}" -lt 6 ] || { echo "ERROR: could not fetch shaderc ${SHADERC_COMMIT}" >&2; exit 1; }
  rm -rf "${src}" && mkdir -p "${src}" && sleep $((4 * n))
done
[ "$(git -C "${src}" rev-parse HEAD)" = "${SHADERC_COMMIT}" ] \
  || { echo "ERROR: shaderc is at $(git -C "${src}" rev-parse HEAD), not ${SHADERC_COMMIT}" >&2; exit 1; }
for n in 1 2 3 4 5 6; do
  ( cd "${src}" && GIT_TERMINAL_PROMPT=0 python3 ./utils/git-sync-deps ) || true
  bad="$(cd "${src}" && python3 - <<'PY'
import os, subprocess
# Evaluate DEPS the way git-sync-deps does: it is Python, with Var() resolving from vars.
g = {}
exec(compile(open("DEPS").read(), "DEPS", "exec"), {"Var": lambda k: g["vars"][k]}, g)
for rel, spec in sorted(g.get("deps", {}).items()):
    rev = spec.partition("@")[2]
    ok = os.path.exists(os.path.join(rel, ".git")) and subprocess.run(
        ["git", "-C", rel, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() == rev
    if not ok:
        print(rel)
PY
  )" || bad="DEPS-unreadable"
  [ -z "${bad}" ] && break
  [ "${n}" -lt 6 ] || { echo "ERROR: shaderc third_party not synced after ${n} attempts: $(echo ${bad})" >&2; exit 1; }
  echo "shaderc git-sync-deps incomplete (attempt ${n}/6): $(echo ${bad}) -- retrying" >&2
  for d in ${bad}; do [ "${d}" = DEPS-unreadable ] || rm -rf "${src:?}/${d}"; done
  sleep $((4 * n))
done
cmake -S "${src}" -B "${src}/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build "${src}/build" --target glslc_exe -j"$(nproc)"
install -m755 "${src}/build/glslc/glslc" /usr/local/bin/glslc
rm -rf "${src}"
# The capability FFmpeg probes, not mere presence.
probe="$(mktemp -d)"
printf '#version 460\nlayout (local_size_x = 1) in;\nvoid main() {}\n' > "${probe}/probe.comp"
glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460 -fshader-stage=compute \
      "${probe}/probe.comp" -o "${probe}/probe.spv" \
  || { echo "ERROR: the built glslc cannot compile --target-env=vulkan1.4 (FFmpeg's spirv_compiler probe)" >&2; exit 1; }
rm -rf "${probe}"
glslc --version
EOF

# clang for FFmpeg's cuda-llvm option: it compiles the CUDA filters' kernels to PTX (NVIDIA's nvcc is nonfree). Only
# FFmpeg's configure calls it (as its nvcc); the libraries' builds still find gcc-toolset's gcc as cc. Probed as
# configure probes it, so an image whose clang can't emit PTX doesn't build.
RUN dnf -y install --setopt=install_weak_deps=False clang \
 && dnf clean all \
 && printf '#define __global__ __attribute__((global))\nextern "C" { __global__ void probe(unsigned char *data) {} }\n' > /tmp/probe.cu \
 && clang --cuda-gpu-arch=sm_30 -O2 -std=c++11 -m64 -S -nocudalib -nocudainc --cuda-device-only /tmp/probe.cu -o /tmp/probe.ptx \
 && grep -q '^.target sm_30' /tmp/probe.ptx \
 && rm -f /tmp/probe.cu /tmp/probe.ptx

# Rust and cargo-c for rav1e (FFmpeg's librav1e: a Rust library whose C API and static library cargo-c builds).
# rustup-init 1.29.1 by sha256, as static.rust-lang.org lists it; Rust 1.98.1 by version (rustup checks each
# component it downloads against that release's manifest); cargo-c 0.10.26's static musl build by sha256, as its
# GitHub release lists it. In /opt, on PATH.
ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:${PATH}
RUN curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init \
 && echo 'dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71  /tmp/rustup-init' | sha256sum -c - \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.1 \
 && rm /tmp/rustup-init \
 && curl -fsSL -o /tmp/cargo-c.tgz https://github.com/lu-zero/cargo-c/releases/download/v0.10.26/cargo-c-x86_64-unknown-linux-musl.tar.gz \
 && echo '685fab5a2e1539c5075cea21c42469ee5a489d877dbdbf7adccf4bb631d77545  /tmp/cargo-c.tgz' | sha256sum -c - \
 && tar -xzf /tmp/cargo-c.tgz -C /opt/cargo/bin \
 && rm /tmp/cargo-c.tgz \
 && rustc --version && cargo cinstall --version
