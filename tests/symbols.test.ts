// win-x64 builds come with their debug symbols (upstream's issue #20): FFmpeg and whisper.cpp compile with -g, `make
// install` strips what ships, and staging keeps the unstripped copies of FFmpeg's build tree in
// symbols-<version>-<target>.tar.gz.
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { debugSections, functionAddress, unstrippedCopies } from '../src/build/stage.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { shipsSymbols, symbolsName } from '../src/targets.ts';

describe('debug symbols', () => {
  it('come with win-x64 builds only, named as upstream named them', () => {
    expect(shipsSymbols('win-x64')).toBe(true);
    for (const p of ['win-arm64', 'linux-x64', 'osx-arm64', 'android-arm64']) {
      expect(shipsSymbols(p)).toBe(false);
    }
    expect(symbolsName('ffmpeg-9.0.2-win-x64-gplv3')).toBe('symbols-9.0.2-win-x64-gplv3.tar.gz');
  });

  it("are compiled in on win-x64: -g in FFmpeg's C flags and whisper.cpp's Release flags, nowhere else", () => {
    const data = loadEngineData(packageRoot);
    const cflags = (p: string) =>
      data.platforms.get(p)!.configure.find((f) => f.startsWith('--extra-cflags='))!;
    expect(cflags('win-x64')).toBe(
      '--extra-cflags=-static-libgcc -static-libstdc++ -O2 -pipe -g -DCHROMAPRINT_NODLL',
    );
    expect(cflags('win-arm64').split(' ')).not.toContain('-g');
    // --disable-debug stays: FFmpeg's own linker flags are unchanged, and `make install` still strips
    expect(data.platforms.get('win-x64')!.configure).not.toContain('--disable-stripping');
    const whisper = data.recipes.get('whisper.cpp')!.build.platforms['win-x64']?.vars;
    expect(whisper?.['release-flags']).toEqual([
      '-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -g',
      '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG -g',
    ]);
  });

  it("are the build tree's unstripped copies: the programs' _g.exe, each DLL in its library's folder", () => {
    const copies = unstrippedCopies('/work/ffmpeg', [
      'ffmpeg.exe',
      'ffprobe.exe',
      'avcodec-62.dll',
      'avfilter-11.dll',
      'swresample-6.dll',
      'postproc-59.dll',
      'vulkan-shim.dll', // not FFmpeg's: no copy in its tree
      'THIRD-PARTY-NOTICES.txt',
    ]);
    expect([...copies]).toEqual([
      ['ffmpeg.exe', join('/work/ffmpeg', 'ffmpeg_g.exe')],
      ['ffprobe.exe', join('/work/ffmpeg', 'ffprobe_g.exe')],
      ['avcodec-62.dll', join('/work/ffmpeg', 'libavcodec', 'avcodec-62.dll')],
      ['avfilter-11.dll', join('/work/ffmpeg', 'libavfilter', 'avfilter-11.dll')],
      ['swresample-6.dll', join('/work/ffmpeg', 'libswresample', 'swresample-6.dll')],
      ['postproc-59.dll', join('/work/ffmpeg', 'libpostproc', 'postproc-59.dll')],
    ]);
  });

  it('are checked: what ships has no DWARF, and a function resolves to its source', () => {
    const stripped = [
      'avfilter-11.dll:     file format pei-x86-64',
      'Idx Name          Size      VMA               LMA               File off  Algn',
      '  0 .text         03f1c2a8  0000000067b81000  0000000067b81000  00000600  2**4',
      '  1 .data         00012340  0000000068a9e000  0000000068a9e000  03f1c800  2**6',
    ].join('\n');
    expect(debugSections(stripped)).toBe(0);
    const unstripped = [
      stripped,
      '  9 .debug_aranges 00004ab0  0000000069001000  0000000069001000  04120000  2**4',
      ' 10 .debug_info   1c2b3f10  0000000069006000  0000000069006000  04124c00  2**0',
      ' 11 .debug_line   02f1a4c0  0000000085132000  0000000085132000  2023e400  2**0',
    ].join('\r\n');
    expect(debugSections(unstripped)).toBe(3);
    const nm = [
      '0000000067b82010 T avfilter_configuration',
      '0000000067b81ff0 t avfilter_version_local',
      '0000000067b81fd0 T avfilter_version',
      '0000000068a9e100 D avfilter_version_data',
      '                 U ggml_init',
      '0000000067c00000 T ggml_init',
    ].join('\n');
    expect(functionAddress(nm, 'avfilter_version')).toBe('0x0000000067b81fd0');
    expect(functionAddress(nm, 'ggml_init')).toBe('0x0000000067c00000');
    expect(functionAddress(nm, 'avfilter_version_data')).toBeUndefined(); // data, not a function
    expect(functionAddress(nm, 'whisper_init')).toBeUndefined();
  });
});
