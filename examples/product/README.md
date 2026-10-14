# A product that uses a published build

`ffmpeg.version` pins a release, `owner/repo@tag`. A product's CI takes the build it needs:

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --dev --out vendor/ffmpeg

and `ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3` (or the update-pin workflow,
[`examples/workflows/update-pin.yml`](../workflows/update-pin.yml)) moves the pin to the newest release of the
same FFmpeg major.

The pin here, `example-org/ffmpeg@9.0.2.0`, is a placeholder: replace it with the repository that publishes your
builds and one of its release tags.
