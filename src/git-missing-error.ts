/** git isn't installed: reading upstream versions needs it. */
export class GitMissingError extends Error {
  constructor() {
    super('ffmpeg-build needs git to read upstream versions; install git and try again.');
  }
}
