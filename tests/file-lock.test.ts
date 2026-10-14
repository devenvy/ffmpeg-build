import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireLock, LockBusyError, readHolder } from '../src/file-lock.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'ffmpeg-build-flock-'));

describe('file locks', () => {
  it('hold a unique token (pid and random), and refuse a second taker while held', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    const held = acquireLock(path, 'x');
    const holder = readHolder(path)!;
    expect(holder.pid).toBe(process.pid);
    expect(holder.token).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{16}$`));
    expect(holder.token).toBe(held.token);
    expect(() => acquireLock(path, 'x')).toThrow(LockBusyError);
    held.release();
    expect(existsSync(path)).toBe(false);
    acquireLock(path, 'x').release();
  });

  it('release only a lock that still holds its token', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    const held = acquireLock(path, 'x');
    writeFileSync(path, `${process.pid} someone-else\n`); // taken over in between
    held.release();
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid} someone-else\n`);
    expect(readdirSync(d)).toEqual(['x.lock']); // nothing left beside it
  });

  it('reclaim a stale lock (its process is gone), leaving nothing behind', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    const held = acquireLock(path, 'x');
    expect(readHolder(path)!.token).toBe(held.token);
    expect(readdirSync(d)).toEqual(['x.lock']);
    held.release();
  });

  it('read the old pid-only lock files too', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, `${process.pid}\n`);
    expect(readHolder(path)!.pid).toBe(process.pid);
    expect(() => acquireLock(path, 'x')).toThrow(/pid/);
  });

  it("put a live lock back when a reclaim raced with its taker, and don't take it", () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    // between the stale read and the rename, another process takes the lock: our rename moves *its* lock away
    let raced = false;
    const live = `${process.pid} ${process.pid}-1111111111111111\n`;
    expect(() =>
      acquireLock(path, 'x', {
        beforeReclaim: () => {
          if (!raced) {
            raced = true;
            writeFileSync(path, live);
          }
        },
      }),
    ).toThrow(LockBusyError);
    expect(readFileSync(path, 'utf8')).toBe(live);
    expect(readdirSync(d)).toEqual(['x.lock']);
  });

  it('never lose a live lock when a slow reclaimer races two later takers (A reads stale, B reclaims, C takes)', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    let b: ReturnType<typeof acquireLock> | undefined;
    let c: ReturnType<typeof acquireLock> | undefined;
    // A has judged the lock stale. Before it acts, B reclaims the same stale lock and takes it for itself.
    const beforeReclaim = () => {
      b ??= acquireLock(path, 'x');
    };
    // Whatever A does next with what it now finds (B's lock), C tries to take the lock while A is mid-step.
    const tryC = () => {
      if (!c) {
        try {
          c = acquireLock(path, 'x');
        } catch (e) {
          if (!(e instanceof LockBusyError)) {
            throw e;
          }
        }
      }
    };
    expect(() => acquireLock(path, 'x', { beforeReclaim, beforeRemove: tryC })).toThrow(
      LockBusyError,
    );
    expect(b).toBeDefined();
    expect(c).toBeUndefined(); // B still holds it: nobody else may
    expect(readHolder(path)!.token).toBe(b!.token);
    expect(() => acquireLock(path, 'x')).toThrow(LockBusyError);
    b!.release();
    expect(readdirSync(d)).toEqual([]);
  });

  it('leave a later holder alone when the stale lock was reclaimed, used and released before a slow reclaimer acts', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    let c: ReturnType<typeof acquireLock> | undefined;
    const beforeReclaim = () => {
      if (c) {
        return;
      }
      acquireLock(path, 'x').release(); // B reclaims, holds, releases
      c = acquireLock(path, 'x'); // C takes the free lock
    };
    expect(() => acquireLock(path, 'x', { beforeReclaim })).toThrow(LockBusyError);
    expect(readHolder(path)!.token).toBe(c!.token);
    expect(readdirSync(d)).toEqual(['x.lock']);
    c!.release();
  });

  it('let only one of two reclaimers of the same stale lock remove it', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    let second: unknown;
    // A has checked, under its reclaim claim, that the stale lock is still there; B arrives now and must be refused
    const held = acquireLock(path, 'x', {
      beforeRemove: () => {
        try {
          acquireLock(path, 'x');
          second = 'took it';
        } catch (e) {
          second = e;
        }
      },
    });
    expect(second).toBeInstanceOf(LockBusyError);
    expect(readHolder(path)!.token).toBe(held.token);
    held.release();
    expect(readdirSync(d)).toEqual([]);
  });

  it('take over a reclaim whose reclaimer died, and clean its claim up', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '999999999 999999999-0000000000000000\n');
    // a reclaimer of that stale lock crashed holding its claim
    writeFileSync(
      `${path}.reclaim.999999999-0000000000000000.0`,
      '999999998 999999998-0000000000000000\n',
    );
    const held = acquireLock(path, 'x');
    expect(readHolder(path)!.token).toBe(held.token);
    expect(readdirSync(d)).toEqual(['x.lock']);
    held.release();
  });

  it('wait for a young empty lock (being written) rather than taking it', () => {
    const d = dir();
    const path = join(d, 'x.lock');
    writeFileSync(path, '');
    expect(() => acquireLock(path, 'x')).toThrow(LockBusyError);
  });
});
