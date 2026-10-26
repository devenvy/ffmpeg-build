import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, type Harness } from './recipe-harness.ts';
import { searchOutput } from '../src/build/run.ts';
import { checkAppleBinary } from '../src/build/stage.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
  searchOutput: vi.fn(),
}));

const made: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of made.splice(0)) {
    rmSync(h.root, { recursive: true, force: true });
  }
});
function fixture(
  opencv: boolean,
  dependency = '/usr/lib/libSystem.B.dylib',
  rpath = '@loader_path',
) {
  const h = harness('osx-arm64');
  made.push(h);
  h.context.buildPlan.libraries = opencv
    ? [{ name: 'opencv' } as Harness['context']['buildPlan']['libraries'][number]]
    : [];
  const binary = join(h.root, 'run', 'ffmpeg');
  h.write(binary, 'native binary');
  h.onRun = (call) => {
    if (call.command !== 'otool') {
      return undefined;
    }
    return call.args[0] === '-L'
      ? `${binary}:\n\t${dependency} (compatibility version 1.0.0)\n`
      : `cmd LC_RPATH\npath ${rpath} (offset 12)\n`;
  };
  const metadata = {
    needle: h.context.work,
    line: `OpenCV compiler flags: -ffile-prefix-map=${h.context.work}=/work`,
  };
  vi.mocked(searchOutput).mockResolvedValue([metadata]);
  return { h, binary, metadata };
}

describe('Native Apple binary metadata and loader validation', () => {
  it('reports native OpenCV producer paths without rewriting the library', async () => {
    const { h, binary, metadata } = fixture(true);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(checkAppleBinary(h.context, binary)).resolves.toBeUndefined();
    expect(output).toHaveBeenCalledWith(expect.stringContaining(metadata.line));
  });

  it('preserves the producer-path rejection for targets without OpenCV', async () => {
    const { h, binary } = fixture(false);
    await expect(checkAppleBinary(h.context, binary)).rejects.toThrow('contains');
  });

  it.each(['/opt/homebrew/lib/libbad.dylib', '/usr/local/lib/libbad.dylib'])(
    'still rejects a native OpenCV binary loading %s',
    async (dependency) => {
      const { h, binary } = fixture(true, dependency);
      await expect(checkAppleBinary(h.context, binary)).rejects.toThrow('loads');
    },
  );

  it('still rejects machine-local RPATHs after reporting native metadata', async () => {
    const { h, binary } = fixture(true, '/usr/lib/libSystem.B.dylib', '/opt/homebrew/lib');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(checkAppleBinary(h.context, binary)).rejects.toThrow('unsafe LC_RPATH');
  });
});
