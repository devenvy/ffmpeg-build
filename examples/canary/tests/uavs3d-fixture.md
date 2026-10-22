The AVS3 fixture is generated entirely from the pixel formula in
uavs3d-fixture.json. No external sample media or pretrained data is used.
The expected digest is the encoder's reconstruction, in display order,
not the uncompressed source before lossy encoding.

Reproduction uses the official uavs3e encoder at the recorded commit, built
in the engine's pinned Linux x64 toolchain with its original /usr/bin/gcc
compiler. GCC 14 rejects old upstream SIMD pointer types; the original compiler
builds this separate fixture-generation tool without modifying its source.

```sh
cmake -S uavs3e -B encoder-build -DCMAKE_BUILD_TYPE=Release \
  -DCOMPILE_10BIT=0 -DCMAKE_C_COMPILER=/usr/bin/gcc \
  -DCMAKE_CXX_COMPILER=/usr/bin/g++ -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build encoder-build -j8
encoder-build/uavs3enc --config authored.cfg
```

The configuration sets input/output/reconstruction paths, width=height=128,
fps_num=8, fps_den=1, input_bit_depth=8 and frames=8. Match upstream's padded
configuration columns before the colon. All other encoder options retain their
defaults. The encoder reported all eight frames and 53.8116 dB luma PSNR.
The encoder's BSD-4-Clause software is not bundled with the fixture or recipe.
