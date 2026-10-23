The MPEG-H linkage canary downloads one test-only file from the official
Fraunhofer-IIS/mpegh-test-content repository, pinned to commit
405e2ef0366e837ca8ebf5a20b4b9863861d9a96:
`TRI_Fileset_17_514H_D1_D2_D3_O1_24bit2160p50.audio.mp4`.

Copyright 2023 Fraunhofer IIS. The repository distributes this material under
[CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/).
The original file is downloaded unchanged for this test and verified by its
6,733,386-byte length and SHA-256
`7aa464235b1015d3fa77eb5d34b70da6d6b68c07a1cd475a7d3859ed1f46f2af`.
The fixture and decoded PCM are not included in FFmpeg release archives.
Upstream source and license:
https://github.com/Fraunhofer-IIS/mpegh-test-content/tree/405e2ef0366e837ca8ebf5a20b4b9863861d9a96

The test supplies the required stereo target layout and decodes all 60 seconds
through natural EOF. It compares all 11,520,000 PCM bytes against the pinned
static decoder's SHA-256. Timestamp normalization does not modify PCM samples.
The separate FDK AAC test synthesizes its own stereo tones; it checks coexistence
with MPEG-H and channel-specific decoded frequencies, rather than redistributing
any encoded copy of the MPEG-H fixture.
