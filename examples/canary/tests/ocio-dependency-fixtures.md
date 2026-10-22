# Authored OpenColorIO dependency checks

The OCIO dependency targets select static/shared minizip-ng, yaml-cpp, pystring and Imath independently.
OpenColorIO retains its existing static implementation. The matrix includes FFmpeg 8/9 and a shared
zlib dependency case. No external config, model, image or display is required.

`ocio-dependencies.mjs` owns a two-colorspace YAML config and an affine 3D LUT. The transform is
R' = 0.5R + 0.125, G' = 0.5G + 0.250, B' = 0.5B + 0.375. Every planar float channel is checked
against those values using the authored RGB samples in `ocio-colors.json`.

The same config and relative `./affine.cube` LUT are placed in an ordinary DEFLATE ZIP with root
`config.ocio` and `luts/affine.cube`. The unpacked config/LUT are removed before running the `.ocioz`
case, proving archive-only retrieval. Directory and archive results must match. A second archive
containing no LUT must fail. This exercises ZIP decompression, YAML parsing, relative-path
normalization and actual FFmpeg FileTransform pixels.

Shared recipe builds compile and execute the installed native SDKs:

- Minizip reads authored stored/deflated entries, rejects a corrupted stored CRC, writes an archive
  read back by Python, and checks its memory stream read/seek/tell/close lifecycle.
- YAML returns nodes and strings to an external caller, preserves aliases, emits/reparses, and throws
  exceptions caught outside the library as both YAML types and `std::exception`.
- Pystring returns strings and vectors for external destruction, split/join/replacement and path normalization.
- Imath exposes its half lookup table, compiled stream operators and all four global `printBits`
  overloads, including float-only overloads outside the Imath namespace.

Public C++ namespaces, RTTI, vtables, thunks and native data remain exported. Embedded C++ implementation
symbols remain private with a common unwinder; minizip keeps embedded zlib private. No dependency mode
is forced merely because these libraries are consumed together behind OCIO's public API.
