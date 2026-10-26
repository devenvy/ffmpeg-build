The FFmpeg OCR consumer links against the archived FFmpeg headers and libraries
using the emulator host's NDK, as the engine's ordinary Android smoke test does.
It verifies `HELLO WORLD 123`, exact unchanged grayscale pixels and filter EOF.
The owned 1100 by 180 PGM reuses the OCR cohort's fixture: Arial rendered the
pixels, and no font file is distributed. Its decompressed SHA-256 is
`455a1c0dfca94f31d8571127eb909f6794f289583d6808ae3aa8cbf52addca38`.

Recognition uses the Apache-2.0 English tessdata_fast model at commit
`65727574dfcd264acbb0c3e07860e4e9e9b22185`: 4,113,088 bytes, SHA-256
`7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`.
The runner verifies bytes before writing its temporary test data. The model's
[upstream license](https://github.com/tesseract-ocr/tessdata_fast/blob/65727574dfcd264acbb0c3e07860e4e9e9b22185/LICENSE)
applies; the model is not bundled in FFmpeg releases.
