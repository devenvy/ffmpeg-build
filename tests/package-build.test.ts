import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPackage } from '../scripts/build.ts';

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ffb-package-build-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist/build'), { recursive: true });
  writeFileSync(join(root, 'src/cli.ts'), source);
  writeFileSync(join(root, 'dist/build/ffmpeg-torch.js'), 'stale removed implementation');
  writeFileSync(join(root, 'keep.txt'), 'keep');
  writeFileSync(
    join(root, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'dist', types: [], noEmitOnError: true },
      include: ['src/**/*.ts'],
    }),
  );
  return root;
}

describe('package builds discard obsolete emitted code', () => {
  it('compiles current sources without retaining a removed implementation', () => {
    const root = fixture('const current: string = "current";');
    try {
      expect(buildPackage(root)).toBe(0);
      expect(existsSync(join(root, 'dist/build/ffmpeg-torch.js'))).toBe(false);
      expect(readFileSync(join(root, 'dist/cli.js'), 'utf8')).toContain('current');
      expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a broken build without leaving stale output that could be packed', () => {
    const root = fixture('const broken: string = 123;');
    try {
      expect(buildPackage(root)).not.toBe(0);
      expect(existsSync(join(root, 'dist/build/ffmpeg-torch.js'))).toBe(false);
      expect(existsSync(join(root, 'dist/cli.js'))).toBe(false);
      expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
