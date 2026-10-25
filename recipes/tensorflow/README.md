# TensorFlow CPU Graph and Eager APIs

This recipe is CPU-only on Linux x64, defaults to static, and offers a bundled
shared mode through the native monolithic C runtime. It preserves the exact Bazel
repository inputs, binary build tools, upstream-owned LLVM build patches and replay
helpers. Engine metadata reads the existing native Bazel targets; it does not
replace them or edit their sources. Tool inputs are labelled separately from linked runtime libraries.
The Go toolchain configuration is rendered from the verified upstream rules_go
SDK template with its native platform substitutions; the engine carries no copy
of that build description. Its template origin and checksum are retained.
The installed API includes Graph/session and Eager entry points. Experimental
headers contain C++ declarations and are checked separately with a C++ compiler;
the stable Graph and Eager runtime probes compile as C.
Static mode packages byte-identical native archives. A compiler response file
preserves their native registration and whole-archive flags without combining
or renaming objects. Stock FFmpeg's plain `-ltensorflow` probe also receives that
response file. Incompatible native static compositions must be rejected rather
than repaired through symbol rewriting.
Shared mode retains the native TensorFlow export script and SONAME without a
separate framework library. Its actual native link inputs must all appear in
the captured CcInfo inventory before compilation begins and again on export.
The runtime licence gate is LGPLv3/nonfree because its actual closure includes
Apache-2.0 dependencies and BoringSSL's original OpenSSL terms.

The runtime notice inventory is strict. `tool-inputs.txt` separately preserves
embedded tool notices and identifies omissions in upstream tool distributions;
it does not claim that their package notice collections are complete. In
particular, the upstream sysroot lacks a package manifest and complete notices,
and Python's install-only archive lacks its full dependency notice collection.
`runtime.txt` includes pinned GCC 8.4.0 copyright and exception texts for the
statically linked compiler runtime. Shared builds retain upstream's compiler-runtime
selection instead of forcing static C++ archives. These notices supplement the sysroot's missing
distributor metadata; the GCC runtime exception adds no build licence restriction.

## Offline reconstruction

Use the same pinned Linux x64 toolchain image as the build. It provides the
baseline compiler, Python, Git, tar and Node tools. Disable container networking.

1. Check the primary TensorFlow source archive's digest against the build's
   source record, and extract it into a source folder. It includes the nested
   pinned LLVM checkout under `third_party/ffb_llvm`.
2. In `SOURCES.md`, locate TensorFlow's `source-inventory` metadata row. Its
   original filename is `ffb-source-inputs.json`; the kept bytes are named by
   their digest. Check that digest and use this JSON as `inventory.json` below.
3. Restore the supplemental files from the extracted archive's `sources/`
   folder. Its `supplemental/<sha256>` members are the original verified bytes.
   The restore helper is also preserved as metadata and in the engine recipe.

```sh
python3 restore.py inventory.json /path/to/extracted/sources /path/to/tensorflow
cd /path/to/tensorflow
JOBS=4 python3 .ffb_inputs/replay.py
python3 .ffb_inputs/export.py /tmp/tensorflow-prefix
cc -I/tmp/tensorflow-prefix/include .ffb_inputs/validate.c \
  -L/tmp/tensorflow-prefix/lib -ltensorflow -o /tmp/tensorflow-check
LD_LIBRARY_PATH=/tmp/tensorflow-prefix/lib /tmp/tensorflow-check /tmp/authored-relu.pb
```

The replay reapplies LLVM's reviewed build patches and passes
`--repository_disable_download`. Missing inputs fail without downloading them.
The C API check constructs a local ReLU graph, tests negative and positive
values, and exports it without pretrained weights or Python inference.
