# Security

## Supported versions

| Version                | Supported                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| The latest 0.x release | Yes: fixes ship as a new 0.x release (the `@v0` workflows and `@devenvy/ffmpeg-build@0` pick it up) |
| Older 0.x releases     | No: update to the latest 0.x                                                                        |

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/devenvy/ffmpeg-build/security/advisories/new) (Security, Advisories,
**Report a vulnerability**). Please don't open a public issue. You'll get an answer within a week, and the fix and
advisory are published together.

In scope: the CLI and its handling of untrusted input (archives `fetch` unpacks, release manifests, upstream version
listings, `ffmpeg-build.yml`), the build driver and recipes (what they download and how they check it), the toolchain
images, and the reusable workflows.

Vulnerabilities in FFmpeg or in the libraries it is built with belong upstream; once they are fixed there, `ffmpeg-build
update` picks the fixed versions up.
