// Reading a file that may be absent, or must be a plain file. Each opens the path once and decides from what it
// opened: checking the path first (exists, stat) and then reading it leaves a moment for the file to change.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

/** Open for reading without following a link: O_RDONLY is 0, so this is O_NOFOLLOW, or 0 (read) where there is none. */
const NO_FOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? constants.O_RDONLY;

/** The file's text, or undefined when there is none; any other failure (a folder, no permission) throws. */
export function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
}

/**
 * A plain file's text, or undefined for anything else: missing, a folder, a device or FIFO (whose read could block),
 * larger than `maxBytes`, or with `noFollow` a link. A link is refused by opening without following it where the
 * system can (O_NOFOLLOW), and elsewhere by checking that the file opened is the one the path named when it wasn't
 * followed.
 */
export function readPlainFile(
  path: string,
  options: { maxBytes?: number; noFollow?: boolean } = {},
): string | undefined {
  let fd: number;
  try {
    const before = options.noFollow ? lstatSync(path) : undefined;
    if (before && !before.isFile()) {
      return undefined;
    }
    fd = openSync(path, options.noFollow ? NO_FOLLOW : 'r');
    try {
      const st = fstatSync(fd);
      if (before && (st.ino !== before.ino || st.dev !== before.dev)) {
        return undefined;
      }
      if (!st.isFile() || (options.maxBytes !== undefined && st.size > options.maxBytes)) {
        return undefined;
      }
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // missing, a folder (Windows can't open one), or a link O_NOFOLLOW refused
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM' || code === 'ELOOP') {
      return undefined;
    }
    throw e;
  }
}
