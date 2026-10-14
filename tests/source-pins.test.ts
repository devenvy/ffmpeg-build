// What ffmpeg.lock pins besides versions: each git library's commit and each tarball's sha256 (FFmpeg's own too).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listenLocal } from './listen.ts';
import { makeGitRepo, makeScenario, type Scenario } from './upstream-helpers.ts';
import { UpstreamFailure } from '../src/commands/versions.ts';
import { type EngineData, loadEngineData } from '../src/engine-data.ts';
import {
  defaultPinSource,
  pinLock,
  type PinSource,
  requiredPin,
  unpinnedSources,
} from '../src/source-pins.ts';

import type { FolderLock } from '../src/lockfile.ts';
import type { AddressInfo } from 'node:net';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// one scenario for the file: no test changes it, and building it (four git repos, a server) is slow under load
let s: Scenario;
let data: EngineData;
beforeAll(async () => {
  s = await makeScenario();
  data = loadEngineData(s.engine);
});
// s is unset when beforeAll failed
afterAll(async () => (s as Scenario | undefined)?.close());

const lock = (): Omit<FolderLock, 'engine'> => ({
  ffmpeg: { '9': '9.1.0' },
  libraries: { dav1d: '1.5.5', lame: '4.0', x264: 'b'.repeat(40) },
});

/** A pin source that answers from tables and counts what it was asked. */
function fakePins(): PinSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    commitOf: async (repo, ref) => {
      asked.push(`commit ${ref}`);
      return createHash('sha1').update(`${repo} ${ref}`).digest('hex');
    },
    sha256Of: async (name, urls) => {
      const url = urls[0]!;
      asked.push(`sha256 ${name} ${url}`);
      return sha(url);
    },
  };
}

describe('which sources a lock pins', () => {
  it('a git tag by commit, a tarball (and FFmpeg) by sha256, a branch library by its version, which is a commit', () => {
    expect(requiredPin(data, 'dav1d')).toBe('commit');
    expect(requiredPin(data, 'lame')).toBe('sha256');
    expect(requiredPin(data, 'x264')).toBeUndefined();
  });

  it('names what an older lock leaves unpinned', () => {
    expect(unpinnedSources(data, { engine: '0', ...lock() })).toEqual([
      'FFmpeg 9.1.0',
      'dav1d 1.5.5',
      'lame 4.0',
    ]);
    const pins = {
      ffmpeg: { '9': { sha256: 'a'.repeat(64) } },
      libraries: { dav1d: { commit: 'a'.repeat(40) }, lame: { sha256: 'a'.repeat(64) } },
    };
    expect(unpinnedSources(data, { engine: '0', ...lock(), pins })).toEqual([]);
    // a pin of the wrong kind (the recipe moved from git to a tarball) counts as none
    expect(
      unpinnedSources(data, {
        engine: '0',
        ...lock(),
        pins: { ...pins, libraries: { ...pins.libraries, lame: { commit: 'a'.repeat(40) } } },
      }),
    ).toEqual(['lame 4.0']);
  });
});

describe('pinning a lock', () => {
  it('asks upstream for each pin, the ref and tarball as the recipe has them for that version', async () => {
    const pins = fakePins();
    const got = await pinLock(data, lock(), undefined, pins);
    expect(pins.asked.sort()).toEqual([
      'commit 1.5.5',
      `sha256 ffmpeg ${s.ffmpeg.url}/ffmpeg-9.1.0.tar.xz`,
      `sha256 lame ${s.listing.url}/lame-4.0.tar.gz`,
    ]);
    expect(got.ffmpeg['9']).toEqual({ sha256: sha(`${s.ffmpeg.url}/ffmpeg-9.1.0.tar.xz`) });
    expect(got.libraries['dav1d']!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(got.libraries['lame']).toEqual({ sha256: sha(`${s.listing.url}/lame-4.0.tar.gz`) });
    expect(got.libraries['x264']).toBeUndefined();
  });

  it('keeps the pins of versions that did not change, and asks only for the rest', async () => {
    const first = await pinLock(data, lock(), undefined, fakePins());
    const pins = fakePins();
    const moved = { ...lock(), libraries: { ...lock().libraries, dav1d: '1.5.4' } };
    const got = await pinLock(data, moved, { engine: '0', ...lock(), pins: first }, pins);
    expect(pins.asked).toEqual(['commit 1.5.4']);
    expect(got.libraries['lame']).toEqual(first.libraries['lame']);
    expect(got.ffmpeg['9']).toEqual(first.ffmpeg['9']);
  });

  it('says which pins it could not get, and writes nothing', async () => {
    const pins: PinSource = {
      commitOf: async () => {
        throw new Error('no tag 1.5.5');
      },
      sha256Of: async () => 'a'.repeat(64),
    };
    const failed = await pinLock(data, lock(), undefined, pins).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(UpstreamFailure);
    expect((failed as Error).message).toContain('dav1d 1.5.5: no tag 1.5.5');
  });
});

describe('the upstream pin source', () => {
  it('resolves a tag to the commit it names, through an annotated tag', async () => {
    const repo = makeGitRepo(['v1.0', 'v2.0'], { annotated: ['v1.0'] });
    const source = defaultPinSource(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-')));
    expect(await source.commitOf(repo.url, 'v1.0')).toBe(repo.head);
    expect(await source.commitOf(repo.url, 'v2.0')).toBe(repo.head);
    await expect(source.commitOf(repo.url, 'v3.0')).rejects.toThrow(/no tag or branch v3\.0/);
  });

  it('downloads a tarball once, keeps it where a build looks for it, and gives its sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    writeFileSync(join(dir, 'lame-4.0.tar.gz'), 'the tarball');
    const sources = join(dir, 'sources');
    const source = defaultPinSource(sources);
    const url = pathToFileURL(join(dir, 'lame-4.0.tar.gz')).href;
    expect(await source.sha256Of('lame', [url])).toBe(sha('the tarball'));
    expect(readFileSync(join(sources, 'lame', 'lame-4.0.tar.gz'), 'utf8')).toBe('the tarball');
  });

  it('tries the mirrors in turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    writeFileSync(join(dir, 'lame-4.0.tar.gz'), 'the tarball');
    const source = defaultPinSource(join(dir, 'sources'));
    expect(
      await source.sha256Of('lame', [
        `${s.listing.url}/missing.tar.gz`,
        pathToFileURL(join(dir, 'lame-4.0.tar.gz')).href,
      ]),
    ).toBe(sha('the tarball'));
  });

  /** A local server answering every request with `handle`; closed (connections too) by the returned function. */
  async function serve(
    handle: (res: ServerResponse) => void,
  ): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
    let count = 0;
    const server: Server = createServer((_req, res) => {
      count++;
      handle(res);
    });
    await listenLocal(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x-1.0.tar.gz`;
    return {
      url,
      requests: () => count,
      close: async () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  it('gives up on a server that trickles forever, at the overall deadline', async () => {
    const timers: NodeJS.Timeout[] = [];
    const srv = await serve((res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // never idle, never done
      timers.push(
        setInterval(() => {
          res.write('x');
        }, 20),
      );
    });
    try {
      const source = defaultPinSource(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-')), {
        deadlineMs: 300,
        idleMs: 5_000,
        retryDelays: [],
      });
      const started = Date.now();
      await expect(source.sha256Of('x', [srv.url])).rejects.toThrow(/took longer than 0\.3 s/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const t of timers) {
        clearInterval(t);
      }
      await srv.close();
    }
  });

  it('gives up on a server that stops sending, at the idle timeout', async () => {
    const srv = await serve((res) => {
      res.writeHead(200);
      res.write('some');
    });
    try {
      const source = defaultPinSource(mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-')), {
        idleMs: 200,
        retryDelays: [],
      });
      await expect(source.sha256Of('x', [srv.url])).rejects.toThrow(/no data for 0\.2 s/);
    } finally {
      await srv.close();
    }
  });

  it('refuses a download larger than the cap, with or without a Content-Length, and does not retry it', async () => {
    const big = Buffer.alloc(64 * 1024, 1);
    const declared = await serve((res) => {
      res.writeHead(200, { 'content-length': String(big.length) });
      res.end(big);
    });
    const chunked = await serve((res) => {
      res.writeHead(200);
      for (let i = 0; i < 8; i++) {
        res.write(big);
      }
      res.end();
    });
    try {
      const sources = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
      const source = defaultPinSource(sources, { maxBytes: 10_000, retryDelays: [10, 10] });
      await expect(source.sha256Of('x', [declared.url])).rejects.toThrow(/larger than 10000 bytes/);
      await expect(source.sha256Of('x', [chunked.url])).rejects.toThrow(/larger than 10000 bytes/);
      expect([declared.requests(), chunked.requests()]).toEqual([1, 1]);
      expect(readdirSync(join(sources, 'x'))).toEqual([]); // nothing kept, no temporary left
    } finally {
      await declared.close();
      await chunked.close();
    }
  });

  it('holds a file: source to the same size cap, without retrying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    writeFileSync(join(dir, 'x-1.0.tar.gz'), Buffer.alloc(64 * 1024, 1));
    const sources = join(dir, 'sources');
    const source = defaultPinSource(sources, { maxBytes: 10_000, retryDelays: [10, 10] });
    await expect(
      source.sha256Of('x', [pathToFileURL(join(dir, 'x-1.0.tar.gz')).href]),
    ).rejects.toThrow(/larger than 10000 bytes/);
    expect(readdirSync(join(sources, 'x'))).toEqual([]);
  });

  it('holds a file: source to the deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    writeFileSync(join(dir, 'x-1.0.tar.gz'), 'small');
    const source = defaultPinSource(join(dir, 'sources'), { deadlineMs: 0, retryDelays: [] });
    await expect(
      source.sha256Of('x', [pathToFileURL(join(dir, 'x-1.0.tar.gz')).href]),
    ).rejects.toThrow(/took longer than 0 s/);
  });

  it.skipIf(process.platform === 'win32')(
    'stops reading a file: source that never ends (a FIFO fed forever) at the deadline',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
      const fifo = join(dir, 'x-1.0.tar.gz');
      execFileSync('mkfifo', [fifo]);
      const writer = spawn(
        'sh',
        ['-c', 'while :; do printf x; sleep 0.02; done > "$1"', 'sh', fifo],
        { stdio: 'ignore' },
      );
      try {
        const source = defaultPinSource(join(dir, 'sources'), { deadlineMs: 300, retryDelays: [] });
        const started = Date.now();
        await expect(source.sha256Of('x', [pathToFileURL(fifo).href])).rejects.toThrow(
          /took longer than 0\.3 s/,
        );
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        writer.kill('SIGKILL');
      }
    },
  );

  it('refuses a download that differs from the copy the cache kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    writeFileSync(join(dir, 'lame-4.0.tar.gz'), 'the tarball');
    mkdirSync(join(dir, 'sources', 'lame'), { recursive: true });
    writeFileSync(join(dir, 'sources', 'lame', 'lame-4.0.tar.gz'), 'another tarball');
    const source = defaultPinSource(join(dir, 'sources'));
    await expect(
      source.sha256Of('lame', [pathToFileURL(join(dir, 'lame-4.0.tar.gz')).href]),
    ).rejects.toThrow(/differs from the copy the cache kept earlier/);
  });
});
