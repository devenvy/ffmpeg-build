import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { commands, harness, type Harness } from './recipe-harness.ts';
import { submoduleArgs } from '../src/build/fetch.ts';
import { runRecipe } from '../src/build/library.ts';
import {
  editPcField,
  expandArgs,
  expandText,
  globPaths,
  pkgConfigText,
  type Value,
  versionAtLeast,
} from '../src/build/recipe-ops.ts';
import { cxxRuntime } from '../src/build/toolchain.ts';
import { recipeSchema } from '../src/schema/engine.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

const parse = (build: unknown, source: unknown = { git: 'https://example.com/sample' }) =>
  recipeSchema.parse({
    name: 'sample',
    license: 'MIT',
    'license-files': ['COPYING'],
    source,
    versions: { 'git-tags': '^v(.*)$' },
    platforms: 'all',
    build,
  });
const lookup = (values: Record<string, Value>) => (name: string) => values[name];

let made: Harness[] = [];
afterEach(() => {
  for (const h of made) {
    rmSync(h.root, { recursive: true, force: true });
  }
  made = [];
});
function fake(platform: string): Harness {
  const h = harness(platform);
  made.push(h);
  return h;
}
const runBuild = async (h: Harness, build: unknown) =>
  runRecipe(h.context, { version: '1.2.3', build: parse(build).build }, h.src);

describe('placeholders', () => {
  it('fills in values, fallbacks and optional values, and leaves the rest alone', () => {
    const values = lookup({ cc: 'clang', empty: '', list: ['-a', '-b'] });
    expect(expandText('{cc} -O2', values).text).toBe('clang -O2');
    expect(expandText('{nothing}', values).text).toBe('{nothing}');
    expect(expandText('{nothing|gcc} {empty|cc} {cc|gcc}', values).text).toBe('gcc cc clang');
    expect(expandText('{nothing|{cc}-x}', values).text).toBe('clang-x');
    expect(expandText('{EXTRA|}', values).text).toBe('');
    expect(expandText('struct { int x; } {list}', values).text).toBe('struct { int x; } -a -b');
    expect(expandText('--host={empty?}', values)).toEqual({ text: '--host=', dropped: true });
    expect(expandText('--host={cc?}', values)).toEqual({ text: '--host=clang', dropped: false });
  });

  it('splices a list alone in an argument and drops an argument with an empty optional value', () => {
    const values = lookup({ list: ['-a', '-b'], none: [], host: '' });
    expect(expandArgs(['x', '{list}', '{none}', '--host={host?}', 'y={list}'], values)).toEqual([
      'x',
      '-a',
      '-b',
      'y=-a -b',
    ]);
  });
});

describe('globs', () => {
  it('matches names, any depth with **, case-insensitively when asked, sorted', () => {
    const h = fake('linux-x64');
    for (const path of [
      'lib/libvulkan.so',
      'lib/libvulkan.so.1',
      'lib/libvulkan-1.a',
      'share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake',
      'lib/.hidden.so',
    ]) {
      mkdirSync(join(h.deps, path, '..'), { recursive: true });
      writeFileSync(join(h.deps, path), '');
    }
    const at = (p: string) => `${h.deps}/${p}`; // the folder as given, then / as find(1) prints
    expect(globPaths(`${h.deps}/lib/libvulkan.so*`)).toEqual([
      at('lib/libvulkan.so'),
      at('lib/libvulkan.so.1'),
    ]);
    expect(globPaths(`${h.deps}/lib/*.so`)).toEqual([at('lib/libvulkan.so')]);
    expect(globPaths(`${h.deps}/**/spirv-headers*config.cmake`)).toEqual([]);
    expect(globPaths(`${h.deps}/**/spirv-headers*config.cmake`, true)).toEqual([
      at('share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake'),
    ]);
    expect(globPaths(`${h.deps}/lib/libvulkan-1.a`)).toEqual([at('lib/libvulkan-1.a')]);
    expect(globPaths(`${h.deps}/lib/nothing.a`)).toEqual([]);
  });
});

describe('pkg-config files', () => {
  it('writes the layout recipes wrote by hand', () => {
    expect(
      pkgConfigText('/deps', {
        name: 'x265',
        description: 'H.265/HEVC video encoder',
        version: '4.1',
        libs: '-lx265',
        libsPrivate: '-lstdc++ -lm',
        execPrefix: true,
      }),
    ).toBe(
      [
        'prefix=/deps',
        `exec_prefix=\${prefix}`,
        `libdir=\${prefix}/lib`,
        `includedir=\${prefix}/include`,
        '',
        'Name: x265',
        'Description: H.265/HEVC video encoder',
        'Version: 4.1',
        `Libs: -L\${libdir} -lx265`,
        'Libs.private: -lstdc++ -lm',
        `Cflags: -I\${includedir}`,
        '',
      ].join('\n'),
    );
    // header-only: no libdir, no Libs
    expect(
      pkgConfigText('/deps', {
        name: 'Vulkan-Headers',
        description: 'd',
        version: '1.4.321',
        cflags: '-DX',
        execPrefix: false,
      }),
    ).toBe(
      `prefix=/deps\nincludedir=\${prefix}/include\n\nName: Vulkan-Headers\nDescription: d\nVersion: 1.4.321\nCflags: -I\${includedir} -DX\n`,
    );
  });

  const pc = `prefix=/deps\nName: x\nLibs: -L\${libdir} -lx\nLibs.private: -lm  -lgcc_s\nCflags: -I\${includedir}\n`;
  const noPrivate = `prefix=/deps\nLibs: -L\${libdir} -lx\nCflags: -I\${includedir}\n`;
  it('appends, prepends, sets, adds and removes words on a field, as sed did', () => {
    expect(editPcField(pc, 'libs-private', { append: '-lstdc++ -lm', missing: 'end' })).toContain(
      '\nLibs.private: -lm  -lgcc_s -lstdc++ -lm\n',
    );
    expect(
      editPcField(pc, 'libs-private', { prepend: '-lmbedtls -lmbedcrypto', missing: 'end' }),
    ).toContain('\nLibs.private: -lmbedtls -lmbedcrypto -lm  -lgcc_s\n');
    expect(editPcField(pc, 'libs-private', { set: '-ldl', missing: 'end' })).toContain(
      '\nLibs.private: -ldl\n',
    );
    expect(editPcField(pc, 'libs-private', { add: '-lm -lc++ -lx', missing: 'end' })).toContain(
      '\nLibs.private: -lm  -lgcc_s -lc++\n',
    );
    expect(editPcField(pc, 'libs-private', { add: '-lm', missing: 'end' })).toBe(pc);
    expect(editPcField(pc, 'libs-private', { remove: '-lgcc_s', missing: 'end' })).toContain(
      '\nLibs.private: -lm\n',
    );
    expect(editPcField(pc, 'cflags', { append: '-DKVZ_STATIC_LIB', missing: 'skip' })).toContain(
      `\nCflags: -I\${includedir} -DKVZ_STATIC_LIB\n`,
    );
  });

  it('adds a missing field at the end, after Libs:, or not at all', () => {
    expect(editPcField(noPrivate, 'libs-private', { append: '-lc++ -lm', missing: 'end' })).toBe(
      `${noPrivate}Libs.private: -lc++ -lm\n`,
    );
    expect(editPcField(noPrivate, 'libs-private', { add: '-lc++  -llog', missing: 'end' })).toBe(
      `${noPrivate}Libs.private: -lc++ -llog\n`,
    );
    expect(editPcField(noPrivate, 'libs-private', { set: '-ldl', missing: 'after-libs' })).toBe(
      `prefix=/deps\nLibs: -L\${libdir} -lx\nLibs.private: -ldl\nCflags: -I\${includedir}\n`,
    );
    expect(editPcField(noPrivate, 'libs-private', { prepend: '-lmbedtls', missing: 'skip' })).toBe(
      noPrivate,
    );
    expect(editPcField(noPrivate, 'libs-private', { remove: '-lm', missing: 'end' })).toBe(
      noPrivate,
    );
  });

  it('normalizes complete pkg-config linker tokens without changing other libraries or fields', () => {
    const metadata =
      'Libs.private: /old/lib/libmbedcrypto.a /old/lib/libmbedcrypto.so.16 -lmbedcrypto /old/lib/libmbedcryptography.a\nCflags: -DKEEP\n';
    expect(
      editPcField(metadata, 'libs-private', {
        removeLibraryPaths: ['mbedcrypto'],
        missing: 'skip',
      }),
    ).toBe('Libs.private:   -lmbedcrypto /old/lib/libmbedcryptography.a\nCflags: -DKEEP\n');
    expect(
      editPcField(
        'Libs.private: -l-lpthread -l-pthread -pthread\nCflags: -l-pthread\n',
        'libs-private',
        {
          tokens: { '-l-lpthread': '-lpthread', '-l-pthread': '-pthread' },
          missing: 'skip',
        },
      ),
    ).toBe('Libs.private: -lpthread -pthread -pthread\nCflags: -l-pthread\n');
  });
});

describe('small pieces', () => {
  it('compares versions as sort -V', () => {
    expect(versionAtLeast('2.16.01', '2.14')).toBe(true);
    expect(versionAtLeast('2.14', '2.14')).toBe(true);
    expect(versionAtLeast('2.13.02', '2.14')).toBe(false);
  });

  it('names the C++ runtime each platform links statically', () => {
    expect(
      [
        'osx-arm64',
        'ios-sim-arm64',
        'maccatalyst-x64',
        'android-x64',
        'win-arm64',
        'win-x64',
        'linux-musl-arm64',
        'linux-armhf',
        'linux-x64',
      ].map(cxxRuntime),
    ).toEqual([
      '-lc++',
      '-lc++',
      '-lc++',
      '-lc++',
      '-l:libc++.a',
      '-lstdc++',
      '-l:libstdc++.a',
      '-lstdc++',
      '-lstdc++',
    ]);
  });

  it('fetches submodules as the source asks', () => {
    const all = parse({ system: 'cmake' }, { git: 'g', submodules: 'true' }).source;
    expect('git' in all && all.submodules).toEqual({ recursive: true, paths: [] });
    expect(submoduleArgs({ recursive: true, paths: [] })).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
    ]);
    const source = parse(
      { system: 'cmake' },
      { git: 'g', submodules: { depth: '1', paths: ['3rdparty/glad', '3rdparty/jinja'] } },
    ).source;
    expect('git' in source && source.submodules).toEqual({
      recursive: false,
      depth: 1,
      paths: ['3rdparty/glad', '3rdparty/jinja'],
    });
    expect(submoduleArgs({ recursive: false, depth: 1, paths: ['3rdparty/glad'] })).toEqual([
      'submodule',
      'update',
      '--init',
      '--depth',
      '1',
      '3rdparty/glad',
    ]);
    expect(
      recipeSchema.safeParse({
        ...parse({ system: 'cmake' }),
        source: { url: 'https://x/y.tar.gz', submodules: 'true' },
      }).success,
    ).toBe(false);
  });
});

describe('declared steps', () => {
  it('runs commands with step environments, variables, conditions and spliced arguments', async () => {
    const h = fake('win-x64');
    writeFileSync(join(h.deps, 'lib', 'libmbedcrypto.a'), '');
    await runBuild(h, {
      system: 'none',
      args: ['--base', '{extra}'],
      vars: { extra: [], mode: 'plain' },
      platforms: {
        'win-*': { args: ['--win'], vars: { mode: 'win' } },
        'linux-*': { args: ['--linux'] },
      },
      env: { FOO: 'recipe', CC: '+= -x' },
      steps: [
        { vars: { extra: ['-e1', '-e2'] }, when: { exists: '{deps}/lib/libmbedcrypto.a' } },
        ['./configure', '--prefix={deps}', '{args}', '--host={host?}', '--mode={mode}'],
        {
          run: ['make', '-j{jobs}'],
          env: { CROSS: '{CROSS_PREFIX}-', CFLAGS: '+= -std=gnu17', CHOST: '{nothing?}' },
          unset: ['NM'],
        },
        { run: ['never'], when: { platforms: ['linux-*'] } },
        { run: ['never'], when: { missing: '{deps}/lib/libmbed*.a' } },
        { run: ['never'], when: { unset: '{host}' } },
        { run: ['cross'], when: { set: '{host}', platforms: ['win-x64'] } },
      ],
    });
    expect(commands(h)).toEqual([
      `./configure --prefix=${h.deps} --base -e1 -e2 --win --host=x86_64-w64-mingw32 --mode=win [CC=x86_64-w64-mingw32-gcc-win32 -x FOO=recipe]`,
      'make -j4 [CC=x86_64-w64-mingw32-gcc-win32 -x CFLAGS= -std=gnu17 CROSS=x86_64-w64-mingw32- FOO=recipe -NM]',
      'cross [CC=x86_64-w64-mingw32-gcc-win32 -x FOO=recipe]',
    ]);
  });

  it('bootstraps with the first script that works, quietly until the last', async () => {
    const h = fake('linux-x64');
    h.onRun = (call) => {
      if (call.command === './autogen.sh') {
        throw new Error('no autogen');
      }
    };
    await runBuild(h, { system: 'none', bootstrap: ['autogen', 'autoreconf'], steps: [['true']] });
    expect(h.calls.map((c) => [c.command, ...c.args, c.capture])).toEqual([
      ['./autogen.sh', true],
      ['autoreconf', '-fi', false],
      ['true', false],
    ]);
    const single = fake('linux-x64');
    await runBuild(single, { system: 'none', bootstrap: 'autogen', steps: [['true']] });
    expect(single.calls.map((c) => [c.command, c.capture])).toEqual([
      ['./autogen.sh', false],
      ['true', false],
    ]);
  });

  it('copies, moves, removes and writes native configuration files', async () => {
    const h = fake('linux-x64');
    for (const [path, text] of [
      ['a.c', 'a'],
      ['b.c', 'b'],
      ['b.h', 'h'],
      ['LICENSES/MIT', 'mit'],
    ] as const) {
      mkdirSync(join(h.src, path, '..'), { recursive: true });
      writeFileSync(join(h.src, path), text);
    }
    writeFileSync(join(h.deps, 'lib', 'ggml.a'), 'g');
    writeFileSync(join(h.deps, 'lib', 'libshaderc_shared.so'), '');
    writeFileSync(join(h.deps, 'lib', 'libshaderc_shared.so.1'), '');
    await runBuild(h, {
      system: 'none',
      steps: [
        { copy: { from: ['*.c', '*.h'], into: '{deps}/src/k', preserve: 'true' } },
        { copy: { from: 'LICENSES', into: '{deps}/src/k', recursive: 'true' } },
        {
          move: { from: '{deps}/lib/ggml.a', to: '{deps}/lib/libggml.a' },
          when: { exists: '{deps}/lib/ggml.a' },
        },
        {
          move: { from: '{deps}/lib/ggml-cpu.a', to: '{deps}/lib/libggml-cpu.a' },
          when: { exists: '{deps}/lib/ggml-cpu.a' },
        },
        { remove: { path: '{deps}/lib/libshaderc_shared.*' } },
        {
          'write-file': {
            path: '{src}/config/native.ini',
            text: '[properties]\nneeds_exe_wrapper = true\n',
          },
        },
      ],
    });
    expect(h.files(h.deps)).toEqual([
      'lib/libggml.a',
      'src/k/LICENSES/MIT',
      'src/k/a.c',
      'src/k/b.c',
      'src/k/b.h',
    ]);
    expect(h.read(join(h.src, 'config', 'native.ini'))).toBe(
      '[properties]\nneeds_exe_wrapper = true\n',
    );
  });

  it('finds, reads and checks', async () => {
    const h = fake('linux-x64');
    mkdirSync(join(h.deps, 'share', 'SPIRV-Headers'), { recursive: true });
    writeFileSync(join(h.deps, 'share', 'SPIRV-Headers', 'SPIRV-HeadersConfig.cmake'), '');
    writeFileSync(join(h.deps, 'lib', 'libvulkan.a'), '!<arch>\nhaicrypt');
    writeFileSync(
      join(h.deps, 'include', 'v.h'),
      '#define VK_API_VERSION_1_3 x\n#define VK_HEADER_VERSION 321\n#define VK_API_VERSION_1_4 y\n',
    );
    h.onRun = (call) =>
      call.command === 'nasm'
        ? 'NASM version 2.16.01 compiled on Jan  1 2024\n'
        : 'current ar archive\n';
    await runBuild(h, {
      system: 'none',
      steps: [
        {
          find: {
            var: 'spirv',
            glob: '{deps}/**/spirv-headers*config.cmake',
            'ignore-case': 'true',
            dirname: 'true',
          },
        },
        {
          find: {
            var: 'shim',
            glob: ['{deps}/lib/libvulkan-1.a', '{deps}/lib/libvulkan.a'],
            basename: 'true',
            required: 'no shim',
          },
        },
        { find: { var: 'none', glob: '{deps}/nothing/*.cmake', dirname: 'true' } },
        {
          read: {
            file: '{deps}/include/v.h',
            pattern: '^#define VK_HEADER_VERSION (\\S+)',
            var: 'rev',
            message: 'no rev',
          },
        },
        {
          read: {
            file: '{deps}/include/v.h',
            pattern: '^#define VK_API_VERSION_1_([34]) ',
            var: 'api',
            last: 'true',
            message: 'needs 1.3+',
          },
        },
        { check: { exists: '{deps}/include', message: 'm' } },
        { check: { missing: '{src}/_build/**/libmbedcrypto.a', message: 'm' } },
        {
          check: {
            file: '{deps}/lib/libvulkan*.a',
            contains: 'HAICRYPT',
            'ignore-case': 'true',
            message: 'm',
          },
        },
        {
          check: {
            output: ['nasm', '-v'],
            matches: '^NASM version ([0-9]+\\.[0-9]+(\\.[0-9]+)?)',
            'min-version': '2.14',
            message: 'm',
          },
        },
        {
          check: {
            output: ['file', '-b', '{deps}/lib/{shim}'],
            matches: 'archive',
            'ignore-case': 'true',
            message: 'm',
          },
        },
        ['echo', '{spirv}', '{shim}', '{none}', '1.{api}.{rev}'],
      ],
    });
    expect(commands(h).at(-1)).toBe(`echo ${h.deps}/share/SPIRV-Headers libvulkan.a . 1.4.321`);

    const failing = async (check: unknown, output = '') => {
      const f = fake('linux-x64');
      f.onRun = () => output;
      return runBuild(f, { system: 'none', steps: [{ check }] });
    };
    await expect(failing({ exists: '{deps}/nothing', message: 'gone' })).rejects.toThrow('gone');
    await expect(
      failing(
        {
          output: ['nasm', '-v'],
          matches: '^NASM version ([0-9.]+)',
          'min-version': '2.14',
          message: 'old nasm',
        },
        'NASM version 2.13.02',
      ),
    ).rejects.toThrow('old nasm (found 2.13.02)');
    await expect(
      failing({ command: 'surely-not-a-command-here', message: 'no tool' }),
    ).rejects.toThrow('no tool');
    await expect(
      failing({ file: '{deps}/lib/pkgconfig', line: 'x', message: 'no file' }),
    ).rejects.toThrow('EISDIR');
  });

  it.each([
    ['shell', { shell: 'make' }],
    ['replace-in-file', { 'replace-in-file': { path: 'config.h', from: '1', to: '2' } }],
  ])(
    'refuses a removed or unknown %s operation in an older build plan',
    async (_name, operation) => {
      const h = fake('linux-x64');
      writeFileSync(join(h.src, 'config.h'), '#define VALUE 1\n');
      const build = {
        ...parse({ system: 'none', steps: [['true']] }).build,
        steps: [operation],
      } as never;
      await expect(runRecipe(h.context, { version: '1', build }, h.src)).rejects.toThrow(
        "a build step this engine doesn't know",
      );
      expect(h.calls).toEqual([]);
      expect(h.read(join(h.src, 'config.h'))).toBe('#define VALUE 1\n');
    },
  );

  it('writes and edits .pc files', async () => {
    const h = fake('android-arm64');
    writeFileSync(
      join(h.deps, 'lib', 'pkgconfig', 'a.pc'),
      `Libs: -L\${libdir} -la\nCflags: -I\${includedir}\n`,
    );
    await runBuild(h, {
      system: 'none',
      vars: { private: '{cxx-runtime} -lm' },
      steps: [
        {
          'pkg-config': {
            name: 'whisper',
            description: 'whisper.cpp speech recognition',
            version: '{version}',
            libs: '-lwhisper',
            'libs-private': '{private}',
          },
        },
        {
          'edit-pkg-config': {
            path: '{deps}/lib/pkgconfig/a.pc',
            'libs-private': { add: '{cxx-runtime} -llog' },
            cflags: { append: '-DA', missing: 'skip' },
          },
        },
        {
          'edit-pkg-config': {
            path: '{deps}/lib/pkgconfig/none.pc',
            optional: 'true',
            libs: { set: 'x' },
          },
        },
      ],
    });
    expect(h.read(join(h.deps, 'lib', 'pkgconfig', 'whisper.pc'))).toBe(
      `prefix=${h.deps}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: whisper\nDescription: whisper.cpp speech recognition\nVersion: 1.2.3\nLibs: -L\${libdir} -lwhisper\nLibs.private: -lc++ -lm\nCflags: -I\${includedir}\n`,
    );
    expect(h.read(join(h.deps, 'lib', 'pkgconfig', 'a.pc'))).toBe(
      `Libs: -L\${libdir} -la\nCflags: -I\${includedir} -DA\nLibs.private: -lc++ -llog\n`,
    );
    expect(existsSync(join(h.deps, 'lib', 'pkgconfig', 'none.pc'))).toBe(false);
  });

  it('relocates pkg-config variables across staged metadata and retains unrelated fields', async () => {
    const h = fake('linux-x64');
    const original = `prefix=/usr\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\nLibs: -L\${libdir} -la\nCflags.private: -DSTATIC\n`;
    for (const name of ['a', 'b']) {
      writeFileSync(join(h.deps, 'lib', 'pkgconfig', `${name}.pc`), original);
    }
    writeFileSync(join(h.src, 'upstream.h'), 'unchanged upstream header\n');
    await runBuild(h, {
      system: 'none',
      steps: [
        {
          'edit-pkg-config': {
            path: '{deps}/lib/pkgconfig/*.pc',
            variables: { prefix: '{deps}' },
            'cflags-private': { remove: '-DSTATIC' },
          },
        },
      ],
    });
    for (const name of ['a', 'b']) {
      expect(h.read(join(h.deps, 'lib', 'pkgconfig', `${name}.pc`))).toBe(
        `prefix=${h.deps}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\nLibs: -L\${libdir} -la\nCflags.private:\n`,
      );
    }
    expect(h.read(join(h.src, 'upstream.h'))).toBe('unchanged upstream header\n');
  });
});
