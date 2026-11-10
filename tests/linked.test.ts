// Which conditional ships: entries (platforms.yml linked:) a build has: read from FFmpeg's configured link,
// ffbuild/config.mak, as configure writes it.
import { describe, expect, it } from 'vitest';

import { configuredLink, shipsInBuild } from '../src/build/linked.ts';

import type { PlannedShip } from '../src/build/plan.ts';

const GCC_RUNTIME = 'GPL-3.0-or-later WITH GCC-exception-3.1';
const libstdcxx: PlannedShip = {
  file: 'libstdc++',
  license: GCC_RUNTIME,
  notice: ['COPYING.RUNTIME'],
  linked: ['libstdc++.a'],
};
const libgcc: PlannedShip = {
  file: 'libgcc',
  license: GCC_RUNTIME,
  notice: ['COPYING.RUNTIME'],
  linked: ['-static-libgcc', '-static'],
  compiler: 'gcc',
};
const winpthread: PlannedShip = { file: 'libwinpthread', license: 'MIT', notice: ['COPYING'] };

/** A config.mak as FFmpeg 9's configure writes it for a musl build with x265 (its .pc rewritten by beforeFfmpeg). */
const MUSL_X265 = [
  'CC_IDENT=gcc 15.2.0 (Alpine 15.2.0)',
  'LD=gcc',
  'LDFLAGS= -static-libgcc -Wl,-z,stack-size=8388608 -L/opt/ffmpeg-build/deps/lib  -Wl,--as-needed',
  'LDEXEFLAGS=',
  'LDSOFLAGS=',
  'SHFLAGS=-shared -Wl,-soname,$$(@F) -Wl,-Bsymbolic -Wl,--version-script,$(SUBDIR)lib$(NAME).ver',
  'EXTRALIBS=',
  'EXTRALIBS-avutil=-pthread -lm -latomic',
  'EXTRALIBS-avcodec=-L/opt/ffmpeg-build/deps/lib -lx265 -l:libstdc++.a -lm -lgcc -ldl -lpthread',
  'EXTRALIBS-ffplay=',
  'CONFIG_AVCODEC=yes',
  'CONFIG_AVUTIL=yes',
  '!CONFIG_FFPLAY=yes',
  '',
].join('\n');

describe('the toolchain archives a build links in (ships: linked:)', () => {
  it('finds libstdc++.a named by -l: and the static-libgcc flag, and says where', () => {
    const ships = shipsInBuild([winpthread, libstdcxx, libgcc], configuredLink(MUSL_X265));
    expect(ships).toEqual([
      winpthread,
      {
        ...libstdcxx,
        evidence: ['libstdc++.a (EXTRALIBS-avcodec)'],
        compilerIdent: 'gcc 15.2.0 (Alpine 15.2.0)',
      },
      {
        ...libgcc,
        evidence: ['-static-libgcc (LDFLAGS)'],
        compilerIdent: 'gcc 15.2.0 (Alpine 15.2.0)',
      },
    ]);
  });

  it('adds nothing for a build with no C++ library, and keeps the entries that are not linked:', () => {
    const plainC = MUSL_X265.replace(
      /^EXTRALIBS-avcodec=.*$/m,
      'EXTRALIBS-avcodec=-L/opt/ffmpeg-build/deps/lib -lx264 -lpthread -lm -ldl',
    );
    expect(
      shipsInBuild([winpthread, libstdcxx], configuredLink(plainC)).map((s) => s.file),
    ).toEqual(['libwinpthread']);
    // a dynamic -lstdc++ (glibc: the system's libstdc++.so.6) is not the static archive
    const glibc = plainC.replace('-lx264', '-lx265 -lstdc++').replace(' -static-libgcc', '');
    expect(shipsInBuild([libstdcxx, libgcc], configuredLink(glibc))).toEqual([]);
  });

  it("reads only what is built: a disabled program's libraries are not linked", () => {
    const onlyFfplay = MUSL_X265.replace('-l:libstdc++.a ', '').replace(
      'EXTRALIBS-ffplay=',
      'EXTRALIBS-ffplay=-l:libstdc++.a',
    );
    expect(shipsInBuild([libstdcxx], configuredLink(onlyFfplay))).toEqual([]);
    // EXTRALIBS itself is on every link line
    const global = onlyFfplay.replace(/^EXTRALIBS=$/m, 'EXTRALIBS=-l:libstdc++.a');
    expect(shipsInBuild([libstdcxx], configuredLink(global))[0]?.evidence).toEqual([
      'libstdc++.a (EXTRALIBS)',
    ]);
  });

  it('counts a plain -l<name> where the link is static: the driver -static, -Bstatic scopes, a path', () => {
    const link = (ldflags: string, avcodec: string) =>
      configuredLink(
        `LDFLAGS=${ldflags}\nCONFIG_AVCODEC=yes\nEXTRALIBS-avcodec=${avcodec}\nCC_IDENT=gcc 16.2.0 (Rev6, Built by MSYS2 project)\n`,
      );
    const has = (ldflags: string, avcodec: string) =>
      shipsInBuild([libstdcxx], link(ldflags, avcodec)).length === 1;
    // MSYS2: beforeFfmpeg adds -static, so configure's own -lstdc++ (rubberband, snappy) is the archive
    expect(has('-static-libgcc -static', '-lrubberband -lstdc++')).toBe(true);
    expect(has('', '-Wl,-Bstatic -lstdc++ -Wl,-Bdynamic')).toBe(true);
    expect(has('', '-Wl,-Bstatic -lpthread -Wl,-Bdynamic -lstdc++')).toBe(false);
    expect(has('', '-Wl,--push-state,-Bstatic -lz -Wl,--pop-state -lstdc++')).toBe(false);
    expect(has('', '-Xlinker -Bstatic -lstdc++')).toBe(true);
    expect(has('-Wl,-Bstatic', '-lstdc++')).toBe(true);
    expect(has('', '/usr/lib/gcc/x86_64-w64-mingw32/13-win32/libstdc++.a')).toBe(true);
    expect(has('', '-lstdc++ -l:libstdc++.dll.a')).toBe(false);
    // the MSYS2 driver flag shows libgcc too
    expect(shipsInBuild([libgcc], link('-static', ''))[0]?.evidence).toEqual(['-static (LDFLAGS)']);
  });

  it("limits a compiler's flag to that compiler: clang's -static-libgcc is not GCC's libgcc", () => {
    const clang = MUSL_X265.replace(
      'CC_IDENT=gcc 15.2.0 (Alpine 15.2.0)',
      'CC_IDENT=clang version 21.1.2 (https://github.com/llvm/llvm-project.git)',
    );
    expect(shipsInBuild([libgcc], configuredLink(clang))).toEqual([]);
    expect(
      shipsInBuild(
        [libgcc],
        configuredLink(MUSL_X265.replace(/^CC_IDENT=.*$/m, 'CC_IDENT=Alpine gcc x')),
      ),
    ).toHaveLength(1);
    expect(() =>
      shipsInBuild([libgcc], configuredLink(MUSL_X265.replace(/^CC_IDENT=.*\n/m, ''))),
    ).toThrow(
      "FFmpeg's ffbuild/config.mak has no CC_IDENT, which platforms.yml's libgcc (compiler: gcc) needs",
    );
  });
});
