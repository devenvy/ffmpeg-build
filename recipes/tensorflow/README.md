# TensorFlow CPU graph/session C API

This recipe is CPU-only and static on Linux x64. It preserves the exact Bazel
repository inputs, binary build tools, authored target, patches and replay
helpers. Tool inputs are labelled separately from linked runtime libraries.
The installed API is the C graph/session API. Private Protobuf, oneDNN and Xbyak symbols,
including local COMDAT signatures, are renamed throughout the static closure so
other selected ML backends can retain their own versions. The mapping is kept in
`share/ffmpeg-build/tensorflow-private-symbols.map`; offline export repeats this step.
The runtime licence gate is LGPLv3/nonfree because its actual closure includes
Apache-2.0 dependencies and BoringSSL's original OpenSSL terms.

The runtime notice inventory is strict. `tool-inputs.txt` separately preserves
embedded tool notices and identifies omissions in upstream tool distributions;
it does not claim that their package notice collections are complete. In
particular, the upstream sysroot lacks a package manifest and complete notices,
and Python's install-only archive lacks its full dependency notice collection.

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
/tmp/tensorflow-check /tmp/authored-relu.pb
```

The replay reapplies LLVM's reviewed build patches and passes
`--repository_disable_download`. Missing inputs fail without downloading them.
The C API check constructs a local ReLU graph, tests negative and positive
values, and exports it without pretrained weights or Python inference.
