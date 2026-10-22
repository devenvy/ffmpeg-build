All media and calibration data here are authored for the tests.

SOFA fixtures are six-direction, stereo 32-tap synthetic HRTFs: left impulse 0.5 at
sample 0, right impulse 0.25 at sample 1, 48 kHz. One uses uncompressed float64
datasets; the other deflates its impulse dataset through zlib. The SDK checks the
filters before normalization. FFmpeg's time/frequency implementations must return
the expected stereo impulse positions and amplitudes, including its -3 dB mono
gain, for every output sample through EOF. Regenerate with `python3 author-sofa.py`
using netCDF4 1.7.2 and NumPy 2.2.6; these are authoring tools, not runtime test
dependencies. The committed manifest records the actual input hashes.

Lensfun's database contains only a fictional FFB mount, camera and lens, with a
synthetic poly3 coefficient. Zero calibration must preserve all RGB pixels for
three complete frames; nonzero calibration must change their mapping. The native
C and C++ SDKs must discover this database and produce the same nontrivial point
mapping. No upstream or system camera database is needed.

The 160x128 stabilization scene is an authored 8x8 tiled texture. Its 320 tile
values were generated with Python 3.12 `random.Random(65537).randrange(32,224)`.
The manifest records its twelve known horizontal translations. The test validates
its displacement estimator against those translations, runs both FFmpeg filters,
requires all twelve frames through EOF and measures reduced residual jitter.
The SDK also exercises native writable logging/allocator globals and frame APIs.

The shared libraries retain upstream SONAMEs. The source tagged libmysofa 1.3.5
still declares its native file version as 1.3.3; its SONAME remains `.so.1`.
Vid.stab's v1.1.2 source declares SONAME `.so.1.2`. Lensfun uses `.so.2`.
