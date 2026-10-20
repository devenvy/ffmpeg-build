// musl gives a thread 128 KiB of stack unless the program or a library it starts with asks for more (PT_GNU_STACK's
// size), and FFmpeg's MPEG-TS demuxer, in the ffmpeg program's demux thread, needs more than that
// (devenvy/ffmpeg-build#38): every musl build links with an 8 MiB request, and staging checks each ELF file has it.
import { describe, expect, it } from 'vitest';

import { gnuStackSize } from '../src/build/stage.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const FLAG = '--extra-ldflags=-Wl,-z,stack-size=8388608';

describe("musl builds' thread stacks", () => {
  it('ask for 8 MiB on every musl platform, and only there', () => {
    for (const [name, platform] of data.platforms) {
      expect(platform.configure.includes(FLAG), name).toBe(name.startsWith('linux-musl-'));
    }
  });

  it('are asked for by the platform, not by the recipes that happened to need it first (rav1e, XEVE)', () => {
    for (const [name, recipe] of data.recipes) {
      expect(JSON.stringify(recipe.configure), name).not.toContain('stack-size');
    }
  });

  it("reads the size an ELF file's PT_GNU_STACK asks for, as readelf -lW prints it", () => {
    const readelf = (memsiz: string) =>
      [
        'Program Headers:',
        '  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align',
        '  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x00d4a8 0x00d4a8 R   0x1000',
        `  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 ${memsiz} RW  0x10`,
        '  GNU_RELRO      0x01e8f0 0x000000000001f8f0 0x000000000001f8f0 0x000710 0x000710 R   0x1',
      ].join('\n');
    expect(gnuStackSize(readelf('0x800000'))).toBe(8_388_608);
    expect(gnuStackSize(readelf('0x000000'))).toBe(0);
    expect(gnuStackSize('Program Headers:\n  LOAD 0x0 0x0 0x0 0x1 0x1 R 0x1000\n')).toBeUndefined();
  });
});
