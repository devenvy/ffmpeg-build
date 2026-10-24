import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { beforeFfmpeg } from '../src/build/toolchain.ts';

it('configures Mac Catalyst without rewriting FFmpeg source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ffb-catalyst-source-'));
  try {
    mkdirSync(join(directory, 'libavcodec'));
    const source = join(directory, 'libavcodec', 'videotoolbox.c');
    const original = '#if TARGET_OS_IPHONE\n/* unchanged upstream source fixture */\n#endif\n';
    writeFileSync(source, original);
    const flags = beforeFfmpeg(
      {
        buildPlan: { platform: 'maccatalyst-arm64', setup: 'apple-ios' },
        depsDir: join(directory, 'deps'),
        env: {
          CC: 'clang',
          CXX: 'clang++',
          AR: 'ar',
          RANLIB: 'ranlib',
          SDK_PATH: '/sdk',
          CFLAGS: '-target arm64-apple-ios15.0-macabi',
          CXXFLAGS: '-target arm64-apple-ios15.0-macabi',
          LDFLAGS: '-target arm64-apple-ios15.0-macabi',
        },
      },
      directory,
      ['--disable-videotoolbox'],
    );
    expect(readFileSync(source, 'utf8')).toBe(original);
    expect(flags).toContain('--cc=clang');
    expect(flags).toContain('--disable-videotoolbox');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
