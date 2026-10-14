// One lock helper for everything that must not run twice at once on a machine: a native platform build, a build's
// outputs in --out, a fetch into --out, and the cache commands. A lock is a file created exclusively, holding
// `<pid> <token>` (the token is the pid and 16 random hex digits, so every taker is told apart).
//
// The protocol uses only exclusive create (O_EXCL), read and unlink, so it works the same on Windows and POSIX:
//
// - Taking: create the file with O_EXCL. If it exists and its process is alive, the lock is busy.
// - Releasing: only when the file still holds our token.
// - Reclaiming a stale one (its process is gone). The stale file's "generation" is its token (or `pid<pid>` for an
//   old pid-only file, or `empty` for an empty one older than YOUNG_MS). To remove it a taker must first hold that
//   generation's claim, `<path>.reclaim.<generation>.<epoch>`, created with O_EXCL, starting at epoch 0. A claim whose
//   own holder is alive (or is still being written) means another taker is reclaiming: the lock is busy. A claim whose
//   holder died lets the next epoch be tried, so a reclaimer that crashed never wedges the lock. Holding the claim,
//   the taker reads the lock again and removes it only if it is still that same stale generation; then it removes
//   its claims and tries to take the lock again.
//
// Why no live lock is ever removed:
// 1. Tokens are never reused, so once a generation's file is gone, no file with that generation appears at `path`
//    again; a check "path still holds generation G" is false forever after G is removed.
// 2. Only a holder of G's claim removes G, and at most one live process holds a claim for G while G exists: epoch k
//    is created by one process only (O_EXCL); moving past epoch k needs its holder dead; and claims are removed only
//    after G is gone (or by a holder that gives up without removing it), so an epoch cannot be created a second time while G exists.
// 3. Between that holder's check and its unlink, nothing else can replace G at `path`: a taker's O_EXCL create fails
//    while G is there, G's own process is dead so it doesn't release, and no other process may remove G (2).
// So the unlink removes exactly the stale G. A slow reclaimer that read G long ago either finds G's claim held (busy),
// or takes a fresh claim after G is gone and finds `path` no longer holds G (1), and removes nothing.
// The protocol assumes, as any pid-file lock does, that a live pid isn't reused by an unrelated process meanwhile.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

export class LockBusyError extends Error {
  readonly path: string;
  readonly pid: number | undefined;
  constructor(message: string, path: string, pid: number | undefined) {
    super(message);
    this.path = path;
    this.pid = pid;
  }
}

export interface Holder {
  pid: number;
  token: string;
}

export interface HeldLock {
  readonly path: string;
  readonly token: string;
  /** Removes the lock when it still holds this token; safe to call twice. */
  release: () => void;
}

/** Test hooks, to interleave other takers deterministically at each step of a reclaim. */
export interface LockHooks {
  /** Called after judging the lock stale, before taking the reclaim claim. */
  beforeReclaim?: () => void;
  /** Called holding the claim, after checking the lock is still the stale one, just before removing it. */
  beforeRemove?: () => void;
}

/** A lock file's holder: `<pid> <token>`, or an older pid-only file (no token). Undefined when absent or unreadable. */
export function readHolder(path: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^\s*(\d+)(?:\s+(\S+))?/.exec(text);
  if (!m) {
    return undefined;
  }
  return { pid: Number(m[1]), token: m[2] ?? '' };
}

export function isAlive(pid: number): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, but someone else's
  }
}

/** Random bytes in a lock's token, beside the pid: tells two takers with the same pid apart. */
const TOKEN_BYTES = 8;

const newToken = () => `${String(process.pid)}-${randomBytes(TOKEN_BYTES).toString('hex')}`;

/** An empty or unreadable lock this young may be one being written: it is busy, not stale. */
const YOUNG_MS = 10_000;
/** Crashed reclaimers of one stale lock that a taker will step past before calling the lock busy. */
const MAX_EPOCHS = 50;
/** Tries at the lock before calling it one that keeps changing hands. */
const MAX_ATTEMPTS = 5;

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function tryCreate(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw e;
  }
  try {
    writeSync(fd, `${process.pid} ${token}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Busy unless the file holds a dead process, or is empty/unreadable and old enough not to be one being written. */
function isStale(path: string, holder: Holder | undefined): boolean {
  if (holder) {
    return !isAlive(holder.pid);
  }
  return exists(path) && ageMs(path) >= YOUNG_MS;
}

/** A stale lock's generation, safe in a file name. */
function generation(holder: Holder | undefined): string {
  if (!holder) {
    return 'empty';
  }
  return holder.token ? holder.token.replace(/[^A-Za-z0-9-]/g, '_') : `pid${holder.pid}`;
}

function sameGeneration(path: string, holder: Holder | undefined): boolean {
  const now = readHolder(path);
  if (!holder) {
    return !now && isStale(path, undefined);
  }
  return now?.pid === holder.pid && now.token === holder.token;
}

/** Takes the claim to reclaim `gen`; the claim paths taken (the last is ours), or undefined when another reclaimer is at work. */
function claim(path: string, gen: string, token: string): string[] | undefined {
  const passed: string[] = [];
  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    const c = `${path}.reclaim.${gen}.${epoch}`;
    passed.push(c);
    if (tryCreate(c, token)) {
      return passed;
    }
    if (!isStale(c, readHolder(c))) {
      return undefined;
    } // a live reclaimer has it
    // that reclaimer died: the next epoch decides who takes over
  }
  return undefined;
}

/** Removes the stale lock `holder` left at `path`, under a claim so that only one taker does it. */
function removeStale(
  path: string,
  what: string,
  holder: Holder | undefined,
  token: string,
  hooks: LockHooks,
): void {
  const claims = claim(path, generation(holder), token);
  if (!claims) {
    throw busy(path, what, undefined);
  }
  try {
    if (sameGeneration(path, holder)) {
      hooks.beforeRemove?.();
      unlinkSync(path);
    }
  } finally {
    // the generation is gone now (removed by us, or by an earlier reclaimer): its claims guard nothing
    for (const c of claims.reverse()) {
      rmSync(c, { force: true });
    }
  }
}

/**
 * Takes the lock at `path` for `what` (named in the busy message), or throws LockBusyError naming the holder.
 * `hooks` are for tests (see LockHooks).
 */
export function acquireLock(path: string, what: string, hooks: LockHooks = {}): HeldLock {
  const token = newToken();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryCreate(path, token)) {
      return held(path, token);
    }
    const holder = readHolder(path);
    if (isStale(path, holder)) {
      hooks.beforeReclaim?.();
      removeStale(path, what, holder, token, hooks);
    } else if (exists(path)) {
      throw busy(path, what, holder?.pid);
    } // else released in between: try again
  }
  throw new LockBusyError(
    `couldn't take the lock ${path} for ${what}: it keeps changing hands`,
    path,
    undefined,
  );
}

function busy(path: string, what: string, pid: number | undefined): LockBusyError {
  return new LockBusyError(
    `${what} is in use by another ffmpeg-build${pid ? ` (pid ${pid})` : ''}; wait for it to finish (the lock is ${path})`,
    path,
    pid,
  );
}

function held(path: string, token: string): HeldLock {
  let released = false;
  return {
    path,
    token,
    release() {
      if (released) {
        return;
      }
      released = true;
      // while we live, no reclaimer removes our file, and no one else can create one at `path` while ours is there:
      // so if it holds our token now, it still does when we unlink it
      if (readHolder(path)?.token !== token) {
        return;
      }
      rmSync(path, { force: true });
    },
  };
}
