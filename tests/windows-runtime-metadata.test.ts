import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { beforeFfmpeg } from '../src/build/toolchain.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function normalize(text: string, platform = 'win-x64') {
  const deps = mkdtempSync(join(tmpdir(), 'ffb-windows-runtime-'));
  made.push(deps);
  const directory = join(deps, 'lib/pkgconfig');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'native.pc');
  writeFileSync(file, text);
  const context = { depsDir: deps, buildPlan: { setup: 'windows', platform }, env: {} };
  beforeFfmpeg(context, deps, []);
  const first = readFileSync(file, 'utf8');
  beforeFfmpeg(context, deps, []);
  expect(readFileSync(file, 'utf8')).toBe(first);
  return first;
}

describe('Windows static compiler-runtime metadata', () => {
  it('handles partially wrapped library metadata without a dynamic runtime fallback', () => {
    expect(normalize('Libs.private: -Wl,-Bstatic -lpthread -Wl,-Bdynamic -lstdc++ -lm\n')).toBe(
      'Libs.private: -Wl,-Bstatic -l:libwinpthread.a -Wl,-Bdynamic -l:libstdc++.a -lm\n',
    );
  });

  it('converts every complete runtime token and preserves similarly named libraries', () => {
    expect(
      normalize(
        'Libs: -lstdc++ -lpthread\nLibs.private: -lstdc++ -lwinpthread -lstdc++extra -lpthread_extra\n',
      ),
    ).toBe(
      'Libs: -l:libstdc++.a -l:libwinpthread.a\nLibs.private: -l:libstdc++.a -l:libwinpthread.a -lstdc++extra -lpthread_extra\n',
    );
  });

  it('preserves the existing ARM64 libc++ and unwind archive selection', () => {
    expect(
      normalize('Libs.private: -lc++ -lstdc++ -lunwind -lpthread -lwinpthread\n', 'win-arm64'),
    ).toBe(
      'Libs.private: -l:libc++.a -l:libc++.a -l:libunwind.a -l:libwinpthread.a -l:libwinpthread.a\n',
    );
  });
});
