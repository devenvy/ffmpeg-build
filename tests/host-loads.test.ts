// What the shipped binaries load from the system at run time: read from the staged files, less what the archive has.
import { describe, expect, it } from 'vitest';

import { elfInterpreter, hostLoads, peImports } from '../src/build/host-loads.ts';

describe('what the shipped binaries load from the host', () => {
  it('ELF: each soname no staged file has, by name or SONAME, with what loads it', () => {
    const loads = hostLoads(
      [
        {
          file: 'libavutil.so.61.1.102',
          format: 'ELF',
          soname: 'libavutil.so.61',
          loads: ['libm.so.6', 'libc.so.6'],
        },
        {
          file: 'libavcodec.so.63.1.102',
          format: 'ELF',
          soname: 'libavcodec.so.63',
          loads: ['libavutil.so.61', 'libvulkan.so.1', 'libm.so.6', 'libc.so.6'],
        },
        { file: 'ffmpeg', format: 'ELF', loads: ['libavcodec.so.63', 'libc.so.6'] },
      ],
      ['libavutil.so.61.1.102', 'libavcodec.so.63.1.102', 'ffmpeg', 'libvulkan.so.1'],
    );
    expect(loads).toEqual([
      {
        name: 'libc.so.6',
        format: 'ELF',
        needers: ['ffmpeg', 'libavcodec.so.63.1.102', 'libavutil.so.61.1.102'],
      },
      {
        name: 'libm.so.6',
        format: 'ELF',
        needers: ['libavcodec.so.63.1.102', 'libavutil.so.61.1.102'],
      },
    ]);
  });

  it("ELF: a program's dynamic loader, as readelf prints its PT_INTERP; a library has none", () => {
    expect(
      elfInterpreter(
        '  INTERP         0x000318 0x0000000000000318 R   0x1\n      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n',
      ),
    ).toBe('/lib64/ld-linux-x86-64.so.2');
    expect(elfInterpreter('  LOAD 0x000000 0x0000000000000000 R E 0x1000\n')).toBeUndefined();
  });

  it("PE: imports compared without case, the UCRT's API sets as one entry with its members", () => {
    const objdump = [
      'The Import Tables (interpreted .idata section contents)',
      '\tDLL Name: KERNEL32.dll',
      '\tDLL Name: api-ms-win-crt-runtime-l1-1-0.dll',
      '\tDLL Name: avutil-61.dll',
      '',
    ].join('\n');
    expect(peImports(objdump)).toEqual([
      'KERNEL32.dll',
      'api-ms-win-crt-runtime-l1-1-0.dll',
      'avutil-61.dll',
    ]);
    const loads = hostLoads(
      [
        { file: 'avcodec-63.dll', format: 'PE', loads: peImports(objdump) },
        {
          file: 'avutil-61.dll',
          format: 'PE',
          loads: ['kernel32.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'bcrypt.dll'],
        },
      ],
      ['avcodec-63.dll', 'AVUTIL-61.DLL'],
    );
    expect(loads).toEqual([
      { name: 'bcrypt.dll', format: 'PE', needers: ['avutil-61.dll'] },
      { name: 'KERNEL32.dll', format: 'PE', needers: ['avcodec-63.dll', 'avutil-61.dll'] },
      {
        name: 'Universal C Runtime (api-ms-win-crt-*.dll)',
        format: 'PE',
        needers: ['avcodec-63.dll', 'avutil-61.dll'],
        members: ['api-ms-win-crt-heap-l1-1-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'],
      },
    ]);
  });

  it("Mach-O: install names outside the bundle; @rpath and the archive's own files are not the host's", () => {
    const loads = hostLoads(
      [
        {
          file: 'libavcodec.63.1.102.dylib',
          format: 'Mach-O',
          loads: [
            '@rpath/libavcodec.63.dylib',
            '@rpath/libavutil.61.dylib',
            '/usr/lib/libSystem.B.dylib',
            '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo',
            '/opt/deps/lib/libbundled.1.dylib',
          ],
        },
      ],
      ['libavcodec.63.1.102.dylib', 'libbundled.1.dylib'],
    );
    expect(loads.map((load) => load.name)).toEqual([
      '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo',
      '/usr/lib/libSystem.B.dylib',
    ]);
  });
});
