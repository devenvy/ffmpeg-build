# Authored VMAF and AVS checks

The VMAF/Xavs targets build FFmpeg 8/9 with static/shared libraries and both independent mixed selections.
They use generated YUV420 video, without downloaded media or model files. VMAF's default model is embedded.

`vmaf-xavs-linkage.mjs` evaluates sixteen reference frames against identical and degraded streams.
Every frame index and VMAF score must be present and finite; the identical pooled score must exceed 90
and exceed the degraded score. The same video is encoded with Xavs using zero and two B frames, decoded
with FFmpeg's native CAVS decoder to natural EOF, and checked for all sixteen frames and bounded pixel error.

Shared recipe builds compile the installed native C SDKs. VMAF checks owned picture allocation/ownership,
embedded model loading, every per-frame score, mean pooling and cleanup. Xavs checks its exported
`xavs_levels` data, parameter defaults, picture allocation, four encoded pictures, NAL payloads,
bounded drain and cleanup. Private libsvm/C++ symbols remain hidden, with a static C++ implementation
and common unwinder in shared VMAF. Native ABI majors remain VMAF 3 and Xavs 1; the pinned VMAF release
3.2.1 still reports upstream's internal library file version 3.2.0.

The Xavs public header also declares `xavs_param_parse`, whose implementation is CLI-only in the pinned
upstream source. Both native static and shared library targets omit that CLI object. This existing SDK
discrepancy is separate from the linking choice; the validation covers the implemented native library API.
