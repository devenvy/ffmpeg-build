## What and why

<!-- What this changes, and the reason. Link the issue for anything large (a new platform, a format change). The title
is a conventional commit (feat:, fix:, chore:, ...): it becomes the squash commit's message. -->

## How it was checked

- [ ] The checks CI runs pass locally (`pnpm run lint`, `format:check`, `typecheck`, `knip`, `test:ci`; see
      DEVELOPMENT.md)
- [ ] A recipe or platform change: built for real (`ffmpeg-build build --target ...`), and where a published
      counterpart exists compared with `scripts/compare-published*.sh` (paste the comparison's last lines below)
- [ ] A change to `ffmpeg-build.yml`'s format, a workflow input or a command's output: the docs (`docs/`) say so
- [ ] A workflow change: actions are pinned by commit SHA

<!-- What you built, on which platforms, and anything a reviewer should look at closely. -->
