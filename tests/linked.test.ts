// Which conditional ships: entries (platforms.yml linked:) a build has: read from FFmpeg's configured link,
// ffbuild/config.mak, as configure writes it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configuredLink,
  driverLinkCommand,
  observeCompilerVersion,
  observeDriver,
  shipsInBuild,
} from '../src/build/linked.ts';

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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A toolchain's library folders: each file an ELF shared object, an archive, or a GNU ld script. */
function folders(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-linked-')).replaceAll('\\', '/');
  roots.push(root);
  for (const [path, kind] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    const contents: Record<string, string> = {
      elf: '\u007fELF....',
      ar: '!<arch>\n',
      pe: 'MZ......',
    };
    writeFileSync(join(root, path), contents[kind] ?? kind);
  }
  return root;
}

const ship = (file: string, linked: string[], extra: Partial<PlannedShip> = {}): PlannedShip => ({
  file,
  license: GCC_RUNTIME,
  notice: ['COPYING.RUNTIME'],
  linked,
  ...extra,
});

describe("what FFmpeg's linker driver adds, and how ld finds each -l", () => {
  it("finds the linker command in a driver's -###: GCC's collect2 (before COLLECT_GCC_OPTIONS), clang's ld.lld", () => {
    const gcc = [
      "COLLECT_GCC_OPTIONS='-shared' '-o' 'x.so'",
      ' /usr/libexec/gcc/x86_64-alpine-linux-musl/15.2.0/collect2 -plugin /p/liblto_plugin.so "-plugin-opt=-pass-through=-lgcc" --as-needed -shared -o x.so -L/usr/lib/gcc/x86_64-alpine-linux-musl/15.2.0 x.o -lgcc -lgcc_eh -lc',
      "COLLECT_GCC_OPTIONS='-shared' '-o' 'x.so' '-dumpdir' 'x.so.'",
    ].join('\n');
    expect(driverLinkCommand(gcc)).toEqual([
      '-plugin',
      '/p/liblto_plugin.so',
      '-plugin-opt=-pass-through=-lgcc',
      '--as-needed',
      '-shared',
      '-o',
      'x.so',
      '-L/usr/lib/gcc/x86_64-alpine-linux-musl/15.2.0',
      'x.o',
      '-lgcc',
      '-lgcc_eh',
      '-lc',
    ]);
    const clang =
      'clang version 23.1.2\n "/opt/llvm-mingw/bin/ld.lld" "-m" "arm64pe" "-Bdynamic" "/opt/llvm-mingw/lib/clang/23/lib/windows/libclang_rt.builtins-aarch64.a" "-l:libunwind.a"';
    expect(driverLinkCommand(clang)).toEqual([
      '-m',
      'arm64pe',
      '-Bdynamic',
      '/opt/llvm-mingw/lib/clang/23/lib/windows/libclang_rt.builtins-aarch64.a',
      '-l:libunwind.a',
    ]);
    expect(driverLinkCommand('gcc: error: no input files')).toBeUndefined();
  });

  it('asks the driver with the configured flags, not make syntax, and fails when it prints no link command', () => {
    const calls: string[][] = [];
    const link = configuredLink(
      'LD=x86_64-w64-mingw32-gcc-win32\nLDFLAGS= -static-libgcc -L/deps/lib -Wl,-rpath-link=$(x)\n',
    );
    const observed = observeDriver(link, '/f/libavutil/adler32.o', {}, (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '', stderr: ' "/usr/bin/x86_64-w64-mingw32-ld" -Bdynamic -lgcc' };
    });
    expect(calls).toEqual([
      [
        'x86_64-w64-mingw32-gcc-win32',
        '-shared',
        '-static-libgcc',
        '-L/deps/lib',
        '-###',
        '-o',
        'ffb-link-probe.so',
        '/f/libavutil/adler32.o',
      ],
    ]);
    expect(observed.driver).toEqual({
      variable: 'x86_64-w64-mingw32-gcc-win32 -shared -###',
      words: ['-Bdynamic', '-lgcc'],
    });
    expect(() =>
      observeDriver(link, 'x.o', {}, () => ({ status: 1, stdout: '', stderr: 'no such compiler' })),
    ).toThrow(
      'x86_64-w64-mingw32-gcc-win32 -shared -### printed no link command (exit 1): no such compiler',
    );
    // no LD in config.mak (a stand-in configure): nothing to ask
    expect(
      observeDriver(configuredLink(''), 'x.o', {}, () => ({ status: 1, stdout: '', stderr: '' })),
    ).toEqual(configuredLink(''));
  });

  it("reads the driver's version as GCC and clang give it", () => {
    const run = (clang: boolean) => (_command: string, args: string[]) => {
      if (args.includes('--version')) {
        return {
          status: 0,
          stdout: clang ? 'Alpine clang version 22.1.3\n' : 'gcc (Alpine 15.2.0) 15.2.0\n',
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: `${clang ? '22.1.3' : '15.2.0'}:${args.join(' ')}\n`.replace(/:.*/, '\n'),
        stderr: '',
      };
    };
    expect(observeCompilerVersion('gcc', {}, run(false))).toEqual({
      value: '15.2.0',
      source: 'gcc -dumpfullversion',
    });
    expect(observeCompilerVersion('clang', {}, run(true))).toEqual({
      value: '22.1.3',
      source: 'clang -dumpversion',
    });
    expect(
      observeCompilerVersion('gcc', {}, () => ({
        status: 1,
        stdout: '',
        stderr: 'unknown option',
      })),
    ).toBeUndefined();
  });

  it("musl: libgcc from the driver's own -lgcc, a plain -lstdc++ only through the static runtime folder", () => {
    const root = folders({
      'sys/libstdc++.so': 'elf',
      'sys/libstdc++.a': 'ar',
      'sys/libgcc.a': 'ar',
      'sys/libgcc_eh.a': 'ar',
      'sys/libunwind.a': 'ar',
      'rt/libstdc++.a': 'ar',
    });
    const link = (rt: boolean) => ({
      ...configuredLink(
        `CONFIG_AVFILTER=yes\nLDFLAGS= -static-libgcc${rt ? ` -L${root}/rt` : ''}\nEXTRALIBS-avfilter=-lrubberband -lstdc++ -lunwind\n`,
      ),
      driver: {
        variable: 'gcc -shared -###',
        words: [`-L${root}/sys`, 'x.o', '-lgcc', '-lgcc_eh', '-lc'],
      },
    });
    const all = [
      ship('libstdc++', ['libstdc++.a']),
      ship('libgcc', ['libgcc.a', 'libgcc_eh.a']),
      ship('libunwind', ['libunwind.a']),
    ];
    expect(shipsInBuild(all, link(true)).map((s) => [s.file, s.evidence])).toEqual([
      ['libstdc++', ['libstdc++.a (EXTRALIBS-avfilter)']],
      ['libgcc', ['libgcc.a (gcc -shared -###)', 'libgcc_eh.a (gcc -shared -###)']],
      // only a static one exists: ld takes it
      ['libunwind', ['libunwind.a (EXTRALIBS-avfilter)']],
    ]);
    // without the folder ld takes libstdc++.so (and staging fails the build: it needs a shared C++ runtime)
    expect(shipsInBuild(all, link(false)).map((s) => s.file)).toEqual(['libgcc', 'libunwind']);
  });

  it("glibc: follows gcc-toolset's libstdc++.so script to the archive it adds, and libgcc_s.so's to libgcc.a", () => {
    const root = folders({
      'toolset/libstdc++.so':
        '/* GNU ld script\n   Use the shared library, but some functions are only in\n   the static library, so try that secondarily.  */\nOUTPUT_FORMAT(elf64-x86-64)\nINPUT ( /usr/lib64/libstdc++.so.6 -lstdc++_nonshared AS_NEEDED (/usr/lib64/libstdc++.so.6) )\n',
      'toolset/libstdc++_nonshared.a': 'ar',
      'toolset/libgcc.a': 'ar',
      'toolset/libgcc_s.so': '/* GNU ld script */\nGROUP ( /lib64/libgcc_s.so.1 libgcc.a )\n',
    });
    const link = {
      ...configuredLink(
        'CONFIG_AVCODEC=yes\nLDFLAGS= -Wl,--as-needed\nEXTRALIBS-avcodec=-lx265 -lstdc++ -lm\n',
      ),
      driver: {
        variable: 'gcc -shared -###',
        words: [
          `-L${root}/toolset`,
          'x.o',
          '--push-state',
          '--as-needed',
          '-lgcc_s',
          '--pop-state',
        ],
      },
    };
    expect(
      shipsInBuild(
        [
          ship('libstdc++_nonshared', ['libstdc++_nonshared.a']),
          ship('libgcc', ['libgcc.a', 'libgcc_eh.a']),
        ],
        link,
        {
          runtimes: ['libgcc', 'libstdc++_nonshared'],
          version: { value: '14.2.1', source: 'gcc -dumpfullversion' },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        file: 'libstdc++_nonshared',
        evidence: ['libstdc++_nonshared.a (EXTRALIBS-avcodec)'],
        version: { value: '14.2.1', source: 'gcc -dumpfullversion' },
      }),
      expect.objectContaining({ file: 'libgcc', evidence: ['libgcc.a (gcc -shared -###)'] }),
    ]);
  });

  it('Windows: an import library first, the archive where the link is static; the version only with the compiler', () => {
    const root = folders({
      'mingw/libstdc++.dll.a': 'ar',
      'mingw/libstdc++.a': 'ar',
      'mingw/libpthread.dll.a': 'ar',
      'mingw/libpthread.a': 'ar',
      'mingw/libgcc.a': 'ar',
      'mingw/libgcc_eh.a': 'ar',
    });
    const winpthreadShip = ship('libwinpthread', ['libwinpthread.a', 'libpthread.a'], {
      license: 'MIT',
    });
    const runtimes = [
      ship('libstdc++', ['libstdc++.a']),
      winpthreadShip,
      ship('libgcc', ['libgcc.a', 'libgcc_eh.a']),
    ];
    const link = (driver: string[]) => ({
      ...configuredLink(
        'CONFIG_AVCODEC=yes\nLDFLAGS= -static-libgcc\nEXTRALIBS-avcodec=-lsnappy -lstdc++\n',
        true,
      ),
      driver: { variable: 'gcc -shared -###', words: [`-L${root}/mingw`, ...driver] },
    });
    // the image's win32-thread gcc: no -lpthread of its own; a plain -lstdc++ is the DLL's import library
    const version = { value: '13-win32', source: 'x86_64-w64-mingw32-gcc-win32 -dumpfullversion' };
    const cross = shipsInBuild(runtimes, link(['-Bdynamic', '-lmingw32', '-lgcc', '-lgcc_eh']), {
      runtimes: ['libstdc++', 'libgcc'],
      version,
    });
    expect(cross.map((s) => [s.file, s.version?.value])).toEqual([['libgcc', '13-win32']]);
    // MSYS2's posix-thread gcc with -static: its own -lpthread, in a static link
    const msys2 = shipsInBuild(
      runtimes,
      link(['-Bstatic', '-lmingw32', '-lgcc', '-lgcc_eh', '-lpthread']),
      {
        runtimes: ['libstdc++', 'libgcc'],
        version,
      },
    );
    expect(msys2.find((s) => s.file === 'libwinpthread')).toMatchObject({
      evidence: ['libpthread.a (gcc -shared -###)'],
    });
    // winpthreads is a package of its own: no compiler version for it
    expect(msys2.find((s) => s.file === 'libwinpthread')).not.toHaveProperty('version');
  });
});
