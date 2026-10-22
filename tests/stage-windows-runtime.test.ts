import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, type Harness } from './recipe-harness.ts';
import { stagePlatform } from '../src/build/stage.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

const made: Harness[] = [];
afterEach(() => {
  for (const h of made.splice(0)) {
    rmSync(h.root, { recursive: true, force: true });
  }
});
const fixture = () => {
  const h = harness('win-x64');
  made.push(h);
  h.context.buildPlan.runtime = [];
  const install = join(h.context.work, 'install');
  for (const name of ['avcodec-63.dll', 'ffmpeg.exe', 'ffprobe.exe']) {
    h.write(join(install, 'bin', name), name);
  }
  mkdirSync(join(install, 'include'), { recursive: true });
  return { h, install, runtime: join(h.root, 'run'), development: join(h.root, 'dev') };
};

describe('Windows selected dependency runtimes', () => {
  it('stages selected DLLs and generates import libraries with exact runtime names', async () => {
    const { h, install, runtime, development } = fixture();
    h.write(join(h.deps, 'bin/libiconv-2.dll'), 'iconv');
    h.write(join(h.deps, 'bin/ffb-vulkan-shim.dll'), 'shim');
    h.write(join(h.deps, 'bin/unselected.dll'), 'unused');
    h.context.buildPlan.runtime = ['bin/libiconv-2.dll', 'bin/ffb-vulkan-shim.dll'];
    await stagePlatform(h.context, install, runtime, development);
    expect(existsSync(join(runtime, 'libiconv-2.dll'))).toBe(true);
    expect(existsSync(join(runtime, 'ffb-vulkan-shim.dll'))).toBe(true);
    expect(existsSync(join(runtime, 'unselected.dll'))).toBe(false);
    const imports = h.calls.filter((call) => call.command === 'llvm-dlltool');
    const names = imports.map((call) => [
      call.args[call.args.indexOf('-D') + 1],
      basename(call.args[call.args.indexOf('-l') + 1]!),
    ]);
    expect(names).toEqual([
      ['avcodec-63.dll', 'avcodec.lib'],
      ['ffb-vulkan-shim.dll', 'ffb-vulkan-shim.lib'],
      ['libiconv-2.dll', 'libiconv.lib'],
    ]);
  });

  it('rejects a required runtime glob that has no match', async () => {
    const { h, install, runtime, development } = fixture();
    h.context.buildPlan.runtime = ['bin/missing*.dll'];
    await expect(stagePlatform(h.context, install, runtime, development)).rejects.toThrow(
      'nothing matches',
    );
  });

  it('rejects case-insensitive collisions with installed FFmpeg DLLs', async () => {
    const { h, install, runtime, development } = fixture();
    h.write(join(h.deps, 'bin/AVCODEC-63.dll'), 'wrong owner');
    h.context.buildPlan.runtime = ['bin/AVCODEC-63.dll'];
    await expect(stagePlatform(h.context, install, runtime, development)).rejects.toThrow(
      /runtime.*collision/i,
    );
  });

  it('rejects two selected owners with the same Windows runtime basename', async () => {
    const { h, install, runtime, development } = fixture();
    h.write(join(h.deps, 'first/provider.dll'), 'first');
    h.write(join(h.deps, 'second/PROVIDER.dll'), 'second');
    h.context.buildPlan.runtime = ['first/provider.dll', 'second/PROVIDER.dll'];
    await expect(stagePlatform(h.context, install, runtime, development)).rejects.toThrow(
      /runtime.*collision/i,
    );
  });
});
