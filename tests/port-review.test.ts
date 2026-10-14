// Fixes from the review of the Node build port: native Windows staging and CLANG64, the cache key's modules and the
// native toolchain's tools, Rosetta on Apple silicon, a cache entry that won't unpack, and the Apple pre-check.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import { msys2 } from './helpers.ts';
import { restoreCache } from '../src/build/cache.ts';
import { hostFacts, nativeTools } from '../src/build/host.ts';
import { nativePreflight } from '../src/build/native.ts';
import { toolchainDefinitionFiles } from '../src/build/plan.ts';
import { canRunX64, objdumpFor } from '../src/build/stage.ts';
import { createToolchain } from '../src/build/toolchain.ts';
import { packageRoot } from '../src/paths.ts';

/** An xcrun check that finds it. */
const xcrunFound = (): void => undefined;

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-review-')).replaceAll('\\', '/');
  return { depsDir: `${root}/deps`, work: `${root}/work`, engine: root };
};

describe('the port review', () => {
  it("a native Windows build checks its DLLs with MSYS2's objdump; the image uses the cross one", () => {
    expect(objdumpFor({})).toBe('objdump');
    expect(objdumpFor({ CROSS_PREFIX: 'x86_64-w64-mingw32' })).toBe('x86_64-w64-mingw32-objdump');
  });

  it("MSYS2's CLANG64 builds win-x64 with clang, and checks for clang", () => {
    expect(
      createToolchain({
        platform: 'win-x64',
        setup: 'windows',
        native: true,
        ...dirs(),
        ...msys2({ MSYSTEM: 'CLANG64' }),
      }).env,
    ).toMatchObject({ CC: 'clang', CXX: 'clang++' });
    expect(
      createToolchain({
        platform: 'win-x64',
        setup: 'windows',
        native: true,
        ...dirs(),
        ...msys2({ MSYSTEM: 'MINGW64' }),
      }).env,
    ).toMatchObject({ CC: 'gcc', CXX: 'g++' });
    expect(nativeTools('windows', 'win-x64', 'CLANG64')).toContain('clang');
    expect(nativeTools('windows', 'win-x64', 'CLANG64')).not.toContain('gcc');
    expect(nativeTools('windows', 'win-x64', 'UCRT64')).toContain('gcc');
    expect(hostFacts('windows', 'win-x64', { MSYSTEM: 'CLANG64' }, (t) => t)).toContain(
      'clang: clang',
    );
  });

  it("keys the library cache by every module that runs in or shapes a library's build, not the host-side ones", () => {
    const names = toolchainDefinitionFiles(packageRoot).map((f) => f.replace(/^.*[\\/]/, ''));
    for (const n of [
      'library.ts',
      'recipe-ops.ts',
      'run.ts',
      'fetch.ts',
      'toolchain.ts',
      'stage.ts',
      'ffmpeg.ts',
    ]) {
      expect(names, n).toContain(n);
    }
    for (const n of ['docker.ts', 'native.ts', 'host.ts']) {
      expect(names, n).not.toContain(n);
    }
  });

  it("records make and the autotools in a native build's toolchain", () => {
    const facts = hostFacts('linux', 'linux-x64', {}, (t) => `${t} 1`);
    for (const t of ['make', 'autoconf', 'automake', 'libtoolize']) {
      expect(facts).toContain(`${t}: ${t} 1`);
    }
  });

  it('knows whether this Mac runs x86_64 programs', async () => {
    expect(await canRunX64({}, async () => '')).toBe(true);
    expect(
      await canRunX64({}, async () => {
        throw new Error('Bad CPU type in executable');
      }),
    ).toBe(false);
  });

  it("stops on a cache entry that won't unpack, rather than building on top of what it left", async () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-review-cache-'));
    writeFileSync(join(root, 'src.tar.gz'), 'source');
    const sha256 = createHash('sha256').update('source').digest('hex');
    writeFileSync(join(root, 'entry.tar.gz'), tarGz([{ name: 'lib/libz.a', data: 'lib' }]));
    const record = JSON.stringify({
      name: 'zlib',
      version: '1',
      origin: 'https://zlib.net/src.tar.gz',
      file: 'src.tar.gz',
      sha256,
    });
    let calls = 0;
    const runner = async () => {
      calls++;
      if (calls === 1) {
        return record;
      }
      throw new Error('gzip: unexpected end of file');
    };
    await expect(
      restoreCache(join(root, 'entry.tar.gz'), join(root, 'deps'), root, 'zlib', runner as never),
    ).rejects.toThrow(
      /the cache entry .*entry\.tar\.gz for zlib can't be unpacked .*; `ffmpeg-build cache verify --fix` removes it/,
    );
  });

  it('asks an Apple build for Xcode, not bash 4', () => {
    expect(() =>
      nativePreflight(() => {
        throw new Error('xcrun: not found');
      }),
    ).toThrow(/an Apple build needs Xcode.*`ffmpeg-build doctor` says what this machine needs/);
    expect(() => nativePreflight(xcrunFound)).not.toThrow();
  });
});
