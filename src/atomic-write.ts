// Writing the user's files (ffmpeg-build.yml, ffmpeg.lock, a pin file, an update summary) so that a crash, a full disk
// or a second writer never leaves one half-written: each is written to a temporary file of its own in the same folder,
// flushed to disk, then renamed over the old one. Several files that belong together are swapped in with backups, and
// put back if one of them fails; what can't be put back is reported, with where its previous text is.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { displayPath } from './profile.ts';

/** A file that couldn't be written; the message says whether everything was put back as it was. */
export class WriteError extends Error {}

/** Random bytes in a temporary file's name: enough that two writers never pick the same one. */
const UNIQUE_BYTES = 6;

const unique = () => randomBytes(UNIQUE_BYTES).toString('hex');
const sibling = (path: string, kind: 'tmp' | 'bak') =>
  join(dirname(path), `.${basename(path)}.${unique()}.${kind}`);

/** Writes `text` to a new file and flushes it to disk. */
export function writeDurably(path: string, text: string): void {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes a folder's entries (the rename) to disk, where the OS allows it (not Windows). */
function syncDir(dir: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

/** Writes `path` atomically: a same-folder temporary file, flushed, renamed into place. `beforeRename` is a test hook. */
export function writeFileAtomic(
  path: string,
  text: string,
  hooks: { beforeRename?: (temp: string) => void } = {},
): void {
  const temp = sibling(path, 'tmp');
  try {
    writeDurably(temp, text);
    hooks.beforeRename?.(temp);
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  syncDir(dirname(path));
}

/** What an error code means for the file being written, in the words the message uses. */
const REASONS: Record<string, string> = {
  ENOENT: "its folder doesn't exist",
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EBUSY: 'it is in use',
  EISDIR: 'a folder is in the way',
  ENOTEMPTY: 'a folder is in the way',
};

const why = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code;
  return (
    (code !== undefined && Object.hasOwn(REASONS, code) ? REASONS[code] : undefined) ??
    (e as Error).message
  );
};

/** Puts a swapped file's backup back in its place (or removes the new file when there was none before). */
function restore(
  d: { path: string; backup?: string },
  rename: (from: string, to: string) => void,
): void {
  if (!d.backup) {
    rmSync(d.path, { force: true });
    return;
  }
  if (existsSync(d.path) && existsSync(d.backup)) {
    rmSync(d.path, { force: true });
  }
  if (existsSync(d.backup)) {
    rename(d.backup, d.path);
  }
}

/**
 * Writes every file, or none: each is staged and flushed first, then each old one moves to a backup as its new one
 * takes its place. If one fails, the ones already swapped are put back; WriteError says whether that worked.
 * `ops.rename` is a test hook.
 */
export function swapFiles(
  writes: { path: string; text: string }[],
  ops: { rename?: (from: string, to: string) => void } = {},
): void {
  const rename = ops.rename ?? renameSync;
  const staged: { path: string; temp: string }[] = [];
  try {
    for (const w of writes) {
      // only a file is ever replaced: anything else in its way (a folder) stops the write before anything moves
      if (existsSync(w.path) && !statSync(w.path).isFile()) {
        throw Object.assign(new Error('a folder is in the way'), { code: 'EISDIR' });
      }
      const temp = sibling(w.path, 'tmp');
      writeDurably(temp, w.text);
      staged.push({ path: w.path, temp });
    }
  } catch (e) {
    for (const s of staged) {
      rmSync(s.temp, { force: true });
    }
    const failed = writes[staged.length]!;
    throw new WriteError(
      `Couldn't write ${displayPath(failed.path)}: ${why(e)}. Nothing was written.`,
    );
  }
  const done: { path: string; backup?: string }[] = [];
  // the write under way when one fails (set before anything in the loop can throw)
  let current: (typeof staged)[number] | undefined;
  try {
    for (const s of staged) {
      current = s;
      const backup = existsSync(s.path) ? sibling(s.path, 'bak') : undefined;
      if (backup) {
        rename(s.path, backup);
      }
      done.push({ path: s.path, ...(backup ? { backup } : {}) });
      rename(s.temp, s.path);
    }
  } catch (e) {
    // put back what was swapped, the last first; the one that failed may have moved aside already
    const stuck: string[] = [];
    for (const d of done.reverse()) {
      try {
        restore(d, rename);
      } catch {
        stuck.push(
          `couldn't put back ${displayPath(d.path)}: its previous text is in ${displayPath(d.backup!)}`,
        );
      }
    }
    for (const s of staged) {
      rmSync(s.temp, { force: true });
    }
    const head = `Couldn't write ${displayPath(current!.path)}: ${why(e)}.`;
    throw new WriteError(
      stuck.length
        ? `${head} Some files were changed and ${stuck.join('; ')}`
        : `${head} Nothing was changed.`,
    );
  }
  for (const d of done) {
    if (d.backup) {
      rmSync(d.backup, { force: true });
    }
  }
  for (const dir of new Set(writes.map((w) => dirname(w.path)))) {
    syncDir(dir);
  }
}
