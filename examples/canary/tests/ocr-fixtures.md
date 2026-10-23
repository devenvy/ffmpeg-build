The compressed PGM fixture renders the owned text `HELLO WORLD 123`, black on
white at 1100 by 180 pixels. Arial was used to render the pixels; no font file is
distributed. The fixture is gzip/base64 encoded to keep the repository text-only.
The decompressed SHA-256 is
`455a1c0dfca94f31d8571127eb909f6794f289583d6808ae3aa8cbf52addca38`.

Recognition downloads upstream tessdata_fast's Apache-2.0 English model at commit
`65727574dfcd264acbb0c3e07860e4e9e9b22185`, corresponding to the 4.1.0 model set.
The file is 4,113,088 bytes, SHA-256
`7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.
The test checks the hash before recognition and removes its temporary model.
Its license is [upstream LICENSE](https://github.com/tesseract-ocr/tessdata_fast/blob/65727574dfcd264acbb0c3e07860e4e9e9b22185/LICENSE).
The model remains test data and is not bundled in FFmpeg releases.

The external `ocr-sdk.cpp` probe accepts the decoded PGM path and model directory.
It checks recognition through the C and C++ APIs, iterator text/confidence/bounds,
and an external renderer subclass including RTTI and virtual destruction. Native
recipe SDK hooks separately check model-free pixel allocator ownership and PNG.
