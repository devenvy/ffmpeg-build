// The build worker and the modules the toolchain identity hashes: TypeScript in a checkout, the compiled JavaScript in
// an installed package. And the published package really has them (npm pack's own file list).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dockerRunArgs } from '../src/build/docker.ts';
import { buildModules, workerPath } from '../src/build/modules.ts';
import { toolchainDefinitionFiles } from '../src/build/plan.ts';
import { packageRoot } from '../src/paths.ts';

function engineAt(dir: string, withSrc: boolean): string {
  mkdirSync(join(dir, 'dist', 'build'), { recursive: true });
  for (const f of ['worker.js', 'library.js', 'docker.js']) {
    writeFileSync(join(dir, 'dist', 'build', f), '');
  }
  if (withSrc) {
    mkdirSync(join(dir, 'src', 'build'), { recursive: true });
    for (const f of ['worker.ts', 'library.ts', 'docker.ts']) {
      writeFileSync(join(dir, 'src', 'build', f), '');
    }
  }
  return dir;
}

describe('the build modules an engine runs', () => {
  it('a checkout runs its TypeScript; an installed package, or one without src/, its dist/', () => {
    const checkout = engineAt(mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-')), true);
    expect(buildModules(checkout)).toEqual({ dir: 'src/build', ext: '.ts' });
    const installed = engineAt(
      join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-')), 'node_modules', 'ffmpeg-build'),
      true,
    );
    expect(buildModules(installed)).toEqual({ dir: 'dist/build', ext: '.js' });
    const packed = engineAt(mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-')), false);
    expect(buildModules(packed)).toEqual({ dir: 'dist/build', ext: '.js' });
    expect(workerPath(packed, buildModules(packed))).toBe(
      join(packed, 'dist', 'build', 'worker.js'),
    );
  });

  it('runs the same worker in a container, at the mount point', () => {
    const packed = engineAt(mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-')), false);
    const args = dockerRunArgs({
      tag: 't',
      recipes: '/r',
      engine: '/e',
      package: packed,
      cache: '/c',
      out: '/o',
      plan: '/p.json',
    });
    expect(args.slice(-2)).toEqual(['node', '/ffmpeg-build/dist/build/worker.js']);
  });

  it('hashes the modules it runs, without the host-side ones', () => {
    const packed = engineAt(mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-')), false);
    expect(toolchainDefinitionFiles(packed).map((f) => f.replace(/^.*[\\/]/, ''))).toEqual([
      'library.js',
      'worker.js',
    ]);
  });

  it('the published package has every build module and the data a build reads', () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const files = new Set(
      (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path),
    );
    // the compiled modules, as dist/ will hold them (each src/build module has its .js)
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-mod-pack-'));
    cpSync(join(packageRoot, 'src', 'build'), join(dir, 'src', 'build'), { recursive: true });
    for (const ts of toolchainDefinitionFiles(dir)) {
      expect(files, ts).toContain(
        `dist/build/${ts.replace(/^.*[\\/]/, '').replace(/\.ts$/, '.js')}`,
      );
    }
    for (const f of [
      'dist/build/worker.js',
      'dist/cli.js',
      'platforms.yml',
      'licenses.yml',
      'ffmpeg/source.yml',
      'recipes/dav1d/recipe.yml',
      'images/linux-x64/Dockerfile',
    ]) {
      expect(files, f).toContain(f);
    }
  }, 60_000);
});
