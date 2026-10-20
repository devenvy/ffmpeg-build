import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformsOf } from './recipe-harness.ts';
import { type BuildContext, isolateRustLibraries } from '../src/build/library.ts';
import { configureFlags, makeBuildPlan } from '../src/build/plan.ts';
import { run } from '../src/build/run.ts';
import {
  isolateRustArchive,
  readArchive,
  rustLinkProblem,
  rustRenames,
  rustTools,
  writeArchive,
} from '../src/build/rust-archive.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

const data = loadEngineData(packageRoot);
const member = (name: string, bytes: string) => ({ name, data: Buffer.from(bytes) });
const header = (name: string, size: number) =>
  `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(size).padEnd(10)}\`\n`;
const plain = (members: { name: string; data: Buffer }[]) =>
  members.map((m) => ({ name: m.name, data: m.data.toString() }));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ffb-rust-archive-'));
  dirs.push(d);
  return d;
};

describe('ar archives', () => {
  it('writes and reads back every member in order: long names, the same name twice, odd sizes', () => {
    const members = [
      member('cdef_avx2.o', 'asm'),
      member('rav1e-5d74b473be79cb54.alloc-924df7cf38fb930e.alloc-cgu.0.rcgu.o', 'rust!'),
      member('utils.o', 'one'),
      member('utils.o', 'two2'),
    ];
    const bytes = writeArchive(members);
    expect(bytes.subarray(0, 8).toString()).toBe('!<arch>\n');
    expect(plain(readArchive(bytes, 'lib.a'))).toEqual(plain(members));
    // deterministic: no time, owner or group in the headers
    expect(writeArchive(members).equals(bytes)).toBe(true);
    expect(bytes.toString('latin1')).not.toMatch(/\d{9,}/);
  });

  it('reads a GNU archive: skips the symbol index, finds long names in the // table', () => {
    const names = 'a-very-long-member-name.rcgu.o/\nanother-long-member-name.o/\n';
    const bytes = Buffer.from(
      [
        '!<arch>\n',
        header('/', 4),
        'SYMS',
        header('//', names.length),
        names,
        header('/0', 3),
        'abc\n',
        header('/32', 2),
        'de',
        header('short.o/', 1),
        'f\n',
      ].join(''),
    );
    expect(plain(readArchive(bytes, 'lib.a'))).toEqual([
      { name: 'a-very-long-member-name.rcgu.o', data: 'abc' },
      { name: 'another-long-member-name.o', data: 'de' },
      { name: 'short.o', data: 'f' },
    ]);
  });

  it("reads a COFF archive's long names (NUL-terminated) and skips its linker members", () => {
    const names = 'first-long-member-name.rcgu.o\0bcryptprimitives.dll\0';
    const bytes = Buffer.from(
      [
        '!<arch>\n',
        header('/', 2),
        'xx',
        header('/', 2),
        'yy',
        header('//', names.length),
        `${names}\n`,
        header('/0', 1),
        'a\n',
        header('/30', 1),
        'b\n',
      ].join(''),
    );
    expect(plain(readArchive(bytes, 'lib.a'))).toEqual([
      { name: 'first-long-member-name.rcgu.o', data: 'a' },
      { name: 'bcryptprimitives.dll', data: 'b' },
    ]);
  });

  it('reads a BSD archive: names after #1/, and no __.SYMDEF', () => {
    const symdef = '__.SYMDEF SORTED\0\0\0\0';
    const bytes = Buffer.from(
      [
        '!<arch>\n',
        header(`#1/${symdef.length}`, symdef.length + 2),
        `${symdef}ix`,
        header('#1/12', 12 + 3),
        'x.rcgu.o\0\0\0\0abc\n',
      ].join(''),
    );
    expect(plain(readArchive(bytes, 'lib.a'))).toEqual([{ name: 'x.rcgu.o', data: 'abc' }]);
  });

  it('refuses what is not an archive, or one it cannot read whole', () => {
    expect(() => readArchive(Buffer.from('!<thin>\n'), 'lib.a')).toThrow(
      'lib.a is not an ar archive',
    );
    expect(() => readArchive(Buffer.from(`!<arch>\n${header('x.o/', 99)}abc`), 'lib.a')).toThrow(
      'lib.a ends inside its member x.o',
    );
  });
});

// what `nm -P -A -g` says of a Rust static library: its Rust objects (*.rcgu.o) and the C, assembly and import
// members beside them
const NM = [
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: rav1e_config_default T 0 10',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: _RNvCs1njKG4L9aB3_7___rustc12___rust_alloc T 10 8',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: _ZN4core9panicking5panic17h0123456789abcdefE T 20 8',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: anon.17ab9014.0.llvm.1420615 R 0 4',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: rav1e_cdef_filter_avx2 U',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: malloc U',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: rust_eh_personality T 30 8',
  'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: DW.ref.rust_eh_personality V 0 8',
  'lib.a[rav1e-1.rav1e.x-cgu.1.rcgu.o]: _RNvCs1njKG4L9aB3_7___rustc12___rust_alloc U',
  'lib.a[rav1e-1.rav1e.x-cgu.1.rcgu.o]: DW.ref.rust_eh_personality V 0 8',
  'lib.a[rav1e-1.rav1e.x-cgu.1.rcgu.o]: rav1e_version_full T 0 8',
  'lib.a[compiler_builtins-2.compiler_builtins.y-cgu.000.rcgu.o]: __popcountdi2 T 0 8',
  'lib.a[compiler_builtins-2.compiler_builtins.y-cgu.000.rcgu.o]: ceil W 0 8',
  'lib.a[compiler_builtins-2.compiler_builtins.y-cgu.000.rcgu.o]: __chkstk w',
  'lib.a[cdef_avx2.o]: rav1e_cdef_filter_avx2 T 0 99',
  'lib.a[cdef_avx2.o]: helper_in_c T 99 9',
  'lib.a[bcryptprimitives.dll]: __IMPORT_DESCRIPTOR_bcryptprimitives I 0 0',
  'lib.a[bcryptprimitives.dll]: ProcessPrng T 0 0',
  '',
].join('\n');

describe("a Rust library's own names for its copy of Rust", () => {
  it('renames what its Rust objects define, but its C API and the C names they may share', () => {
    const renames = rustRenames(NM, { library: 'rav1e', exports: ['rav1e_*'] });
    expect(Object.fromEntries(renames)).toEqual({
      _RNvCs1njKG4L9aB3_7___rustc12___rust_alloc:
        'ffb.rav1e._RNvCs1njKG4L9aB3_7___rustc12___rust_alloc',
      _ZN4core9panicking5panic17h0123456789abcdefE:
        'ffb.rav1e._ZN4core9panicking5panic17h0123456789abcdefE',
      'anon.17ab9014.0.llvm.1420615': 'ffb.rav1e.anon.17ab9014.0.llvm.1420615',
      rust_eh_personality: 'ffb.rav1e.rust_eh_personality',
      'DW.ref.rust_eh_personality': 'ffb.rav1e.DW.ref.rust_eh_personality',
      __popcountdi2: 'ffb.rav1e.__popcountdi2',
    });
  });

  it("fails on an export no Rust object defines (the recipe's cargo: exports: is wrong)", () => {
    expect(() => rustRenames(NM, { library: 'rav1e', exports: ['rav1e_*', 'ra_*'] })).toThrow(
      "rav1e: cargo: exports: names ra_*, which no Rust object in the library defines (its C names: rav1e_config_default, rav1e_version_full): make exports: match the library's C API",
    );
    expect(() => rustRenames('', { library: 'rav1e', exports: ['rav1e_*'] })).toThrow(
      'rav1e: cargo: exports: names rav1e_*, which no Rust object in the library defines',
    );
  });
});

describe('the tools that rename them', () => {
  it("are the platform's binutils: by the toolchain's nm, its cross prefix, or the plain names", () => {
    expect(rustTools({}, 'linux-x64')).toEqual({ nm: 'nm', objcopy: 'objcopy', ar: 'ar' });
    expect(rustTools({ CROSS_PREFIX: 'arm-linux-gnueabihf' }, 'linux-armhf')).toEqual({
      nm: 'arm-linux-gnueabihf-nm',
      objcopy: 'arm-linux-gnueabihf-objcopy',
      ar: 'arm-linux-gnueabihf-ar',
    });
    expect(
      rustTools(
        {
          CROSS_PREFIX: 'aarch64-w64-mingw32',
          NM: 'aarch64-w64-mingw32-nm',
          AR: 'aarch64-w64-mingw32-ar',
        },
        'win-arm64',
      ),
    ).toEqual({
      nm: 'aarch64-w64-mingw32-nm',
      objcopy: 'aarch64-w64-mingw32-objcopy',
      ar: 'aarch64-w64-mingw32-ar',
    });
    expect(rustTools({ NM: '/ndk/bin/llvm-nm', AR: '/ndk/bin/llvm-ar' }, 'android-arm64')).toEqual({
      nm: '/ndk/bin/llvm-nm',
      objcopy: '/ndk/bin/llvm-objcopy',
      ar: '/ndk/bin/llvm-ar',
    });
  });

  it('are none on Apple, whose Xcode has no objcopy (and where rav1e is the only Rust library)', () => {
    for (const platform of ['osx-arm64', 'ios-arm64', 'ios-sim-arm64', 'maccatalyst-x64']) {
      expect(rustTools({}, platform)).toBeUndefined();
    }
  });
});

describe('isolating a Rust static library', () => {
  it('renames in its Rust objects only, keeps every member where it was, and indexes it again', async () => {
    const dir = temp();
    const lib = join(dir, 'librav1e.a');
    writeFileSync(
      lib,
      writeArchive([
        member('cdef_avx2.o', 'asm uses rust_eh_personality'),
        member('rav1e-1.rav1e.x-cgu.0.rcgu.o', 'calls rust_eh_personality'),
        member('bcryptprimitives.dll', 'import'),
        member('rav1e-1.rav1e.x-cgu.0.rcgu.o', 'second copy: rust_eh_personality'),
      ]),
    );
    const calls: string[][] = [];
    let map = '';
    vi.mocked(run).mockImplementation(async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'x-nm') {
        return 'lib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: rust_eh_personality T 0 8\nlib.a[rav1e-1.rav1e.x-cgu.0.rcgu.o]: rav1e_version_full T 0 8\n';
      }
      if (command === 'x-objcopy') {
        const [option, input, output] = args as [string, string, string];
        map = readFileSync(option.slice('--redefine-syms='.length), 'utf8');
        const members = readArchive(readFileSync(input), input).map((m) => ({
          name: m.name,
          data: Buffer.from(m.data.toString().replaceAll('rust_eh', 'ffb.rav1e.rust_eh')),
        }));
        writeFileSync(output, writeArchive(members));
      }
      return '';
    });
    const renamed = await isolateRustArchive(lib, {
      library: 'rav1e',
      exports: ['rav1e_*'],
      env: { NM: 'x-nm', AR: 'x-ar' },
      platform: 'linux-x64',
      work: dir,
    });
    expect(renamed).toBe(1);
    expect(map).toBe('rust_eh_personality ffb.rav1e.rust_eh_personality\n');
    expect(calls.map((c) => c[0])).toEqual(['x-nm', 'x-objcopy', 'x-ar']);
    expect(calls[0]).toEqual(['x-nm', '-P', '-A', '-g', lib]);
    expect(calls[2]).toEqual(['x-ar', 's', lib]);
    expect(plain(readArchive(readFileSync(lib), lib))).toEqual([
      { name: 'cdef_avx2.o', data: 'asm uses rust_eh_personality' },
      { name: 'rav1e-1.rav1e.x-cgu.0.rcgu.o', data: 'calls ffb.rav1e.rust_eh_personality' },
      { name: 'bcryptprimitives.dll', data: 'import' },
      { name: 'rav1e-1.rav1e.x-cgu.0.rcgu.o', data: 'second copy: ffb.rav1e.rust_eh_personality' },
    ]);
  });

  it("isolates what a Rust recipe installed under lib/, and nothing of another recipe's", async () => {
    const dir = temp();
    mkdirSync(join(dir, 'deps', 'lib', 'pkgconfig'), { recursive: true });
    writeFileSync(join(dir, 'deps', 'lib', 'librav1e.a'), writeArchive([member('a.o', 'c')]));
    writeFileSync(join(dir, 'deps', 'lib', 'pkgconfig', 'rav1e.pc'), 'not an archive');
    const context = {
      depsDir: join(dir, 'deps'),
      env: {},
      work: dir,
      buildPlan: { platform: 'linux-x64' },
    } as unknown as BuildContext;
    const installed = ['lib/librav1e.a', 'lib/pkgconfig/rav1e.pc', 'include/rav1e/rav1e.h'];
    const rav1e = data.recipes.get('rav1e')!;
    await isolateRustLibraries(context, { name: 'rav1e', build: rav1e.build }, installed);
    const zimg = data.recipes.get('zimg')!;
    writeFileSync(join(dir, 'deps', 'lib', 'librav1e.a'), 'not an archive either');
    await isolateRustLibraries(context, { name: 'zimg', build: zimg.build }, installed);
    await expect(
      isolateRustLibraries(context, { name: 'rav1e', build: rav1e.build }, installed),
    ).rejects.toThrow('librav1e.a is not an ar archive');
  });

  it('leaves alone an archive with no Rust object, and every library on Apple', async () => {
    const dir = temp();
    const lib = join(dir, 'libc.a');
    const bytes = writeArchive([member('a.o', 'c')]);
    writeFileSync(lib, bytes);
    vi.mocked(run).mockReset();
    const a = { library: 'x', exports: ['x_*'], env: {}, work: dir };
    expect(await isolateRustArchive(lib, { ...a, platform: 'linux-x64' })).toBe(0);
    writeFileSync(lib, writeArchive([member('x.rcgu.o', 'rust')]));
    expect(await isolateRustArchive(lib, { ...a, platform: 'osx-arm64' })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});

// rav1e and librsvg, both Rust, in one target on every platform both build on (#48): planned together, each with
// its C API named, so each library's copy of Rust gets its own names when it is built
describe('a target with two Rust libraries', () => {
  const both = platformsOf('librsvg').filter((p) => platformsOf('rav1e').includes(p));
  it('is every platform librsvg builds on: Linux, Windows and Android', () => {
    expect(both).toEqual(platformsOf('librsvg'));
    expect(both.every((p) => /^(linux|win|android)-/.test(p))).toBe(true);
  });

  it.each(both)('%s plans both, and the licence table their crates are checked against', (p) => {
    const r = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [${p}]\nlicense: lgplv3\nwith: [rav1e, rsvg]\n`,
      't.yml',
    );
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const planned = planProfile(r.profile, data);
    expect(planned.errors).toEqual([]);
    const cell = planned.cells[0]!;
    const plan = makeBuildPlan({
      profile: r.profile,
      data,
      locked: {
        ffmpeg: { '9': '9.0.2' },
        libraries: Object.fromEntries(cell.recipes.map((n) => [n, '1.0.0'])),
        pinned: [],
      },
      cell,
      variant: 'lgplv3',
      imageId: 'x',
      cacheDir: temp(),
    });
    const rust = plan.libraries.filter((l) => l.build.cargo);
    expect(rust.map((l) => [l.name, l.build.cargo!.exports])).toEqual([
      ['librsvg', ['rsvg_*']],
      ['rav1e', ['rav1e_*']],
    ]);
    expect(plan.cargo?.licenses['MPL-2.0']).toBeDefined();
    expect(configureFlags(data, cell)).toEqual(
      expect.arrayContaining(['--enable-librav1e', '--enable-librsvg']),
    );
  });

  it("is refused where the engine can't give each its own names (Apple, where only rav1e is Rust today)", () => {
    expect(rustLinkProblem(['rav1e', 'librsvg'], 'osx-arm64')).toBe(
      "rav1e and librsvg are Rust static libraries, each with its own copy of Rust's standard library, which can't link into one osx-arm64 build: the engine gives each copy its own names with objcopy, which Xcode hasn't got (leave all but one out)",
    );
    expect(rustLinkProblem(['rav1e'], 'osx-arm64')).toBeUndefined();
    expect(rustLinkProblem(['rav1e', 'librsvg'], 'win-arm64')).toBeUndefined();
  });
});
