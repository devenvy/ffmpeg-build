import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { beforeFfmpeg } from '../src/build/toolchain.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function normalize(text: string, platform = 'win-x64') {
  const deps = mkdtempSync(join(tmpdir(), 'ffb-windows-runtime-'));
  made.push(deps);
  const directory = join(deps, 'lib/pkgconfig');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'native.pc');
  writeFileSync(file, text);
  const context = { depsDir: deps, buildPlan: { setup: 'windows', platform }, env: {} };
  beforeFfmpeg(context, deps, []);
  const first = readFileSync(file, 'utf8');
  beforeFfmpeg(context, deps, []);
  expect(readFileSync(file, 'utf8')).toBe(first);
  return first;
}

describe('Windows static compiler-runtime metadata', () => {
  it('handles partially wrapped library metadata without a dynamic runtime fallback', () => {
    expect(normalize('Libs.private: -Wl,-Bstatic -lpthread -Wl,-Bdynamic -lstdc++ -lm\n')).toBe(
      'Libs.private: -Wl,-Bstatic -l:libwinpthread.a -Wl,-Bdynamic -l:libstdc++.a -lm\n',
    );
  });

  it('converts every complete runtime token and preserves similarly named libraries', () => {
    expect(
      normalize(
        'Libs: -lstdc++ -lpthread\nLibs.private: -lstdc++ -lwinpthread -lstdc++extra -lpthread_extra\n',
      ),
    ).toBe(
      'Libs: -l:libstdc++.a -l:libwinpthread.a\nLibs.private: -l:libstdc++.a -l:libwinpthread.a -lstdc++extra -lpthread_extra\n',
    );
  });

  it('preserves the existing ARM64 libc++ and unwind archive selection', () => {
    expect(
      normalize('Libs.private: -lc++ -lstdc++ -lunwind -lpthread -lwinpthread\n', 'win-arm64'),
    ).toBe(
      'Libs.private: -l:libc++.a -l:libc++.a -l:libunwind.a -l:libwinpthread.a -l:libwinpthread.a\n',
    );
  });
});

describe("the toolchain's real static runtimes", () => {
  const pc = (setup: string, platform: string, text: string, env: NodeJS.ProcessEnv = {}) => {
    const deps = mkdtempSync(join(tmpdir(), 'ffb-runtime-pc-'));
    made.push(deps);
    mkdirSync(join(deps, 'lib/pkgconfig'), { recursive: true });
    writeFileSync(join(deps, 'lib/pkgconfig/native.pc'), text);
    beforeFfmpeg({ depsDir: deps, buildPlan: { setup, platform }, env }, deps, []);
    return readFileSync(join(deps, 'lib/pkgconfig/native.pc'), 'utf8');
  };

  it("MSYS2's CLANG64 gets LLVM's libc++ and libunwind on win-x64, as llvm-mingw does on win-arm64", () => {
    const text = 'Libs.private: -lstdc++ -lunwind -lpthread\n';
    expect(pc('windows', 'win-x64', text, { FFB_IN: 'here', CC: 'clang' })).toBe(
      'Libs.private: -l:libc++.a -l:libunwind.a -l:libwinpthread.a\n',
    );
    expect(pc('windows', 'win-x64', text, { FFB_IN: 'here', CC: 'gcc' })).toBe(
      'Libs.private: -l:libstdc++.a -lunwind -l:libwinpthread.a\n',
    );
  });

  it("musl: a Rust library's -lunwind names the image's static LLVM libunwind, as -lstdc++ does libstdc++", () => {
    expect(
      pc('linux-musl', 'linux-musl-x64', 'Libs.private: -lunwind -lgcc_s -lstdc++ -lunwinding\n'),
    ).toBe('Libs.private: -l:libunwind.a  -l:libstdc++.a -lunwinding\n');
  });

  it("puts a folder of the compiler's static runtime archives first on the link, for a plain -lstdc++ or -lpthread", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffb-static-runtime-'));
    made.push(root);
    const compilerLib = join(root, 'compiler');
    mkdirSync(compilerLib);
    writeFileSync(join(compilerLib, 'libstdc++.a'), '!<arch>\nlibstdc++');
    writeFileSync(join(compilerLib, 'libpthread.a'), '!<arch>\npthread');
    const asked: string[][] = [];
    // as the compiler answers: the path of what it has, the name back for what it hasn't
    const run = (command: string, args: string[]) => {
      asked.push([command, ...args]);
      const name = args[0]!.slice('-print-file-name='.length);
      return name === 'libstdc++.a' || name === 'libpthread.a'
        ? `${join(compilerLib, name)}\n`
        : `${name}\n`;
    };
    const work = join(root, 'work');
    const flags = beforeFfmpeg(
      {
        depsDir: join(root, 'deps'),
        work,
        buildPlan: { setup: 'windows', platform: 'win-x64' },
        env: {},
      },
      root,
      ['--cc=x86_64-w64-mingw32-gcc-win32'],
      run,
    );
    const dir = `${work.replaceAll('\\', '/')}/static-runtime`;
    expect(flags).toEqual(['--cc=x86_64-w64-mingw32-gcc-win32', `--extra-ldflags=-L${dir}`]);
    expect(asked.map((a) => a.join(' '))).toEqual([
      'x86_64-w64-mingw32-gcc-win32 -print-file-name=libstdc++.a',
      'x86_64-w64-mingw32-gcc-win32 -print-file-name=libwinpthread.a',
      'x86_64-w64-mingw32-gcc-win32 -print-file-name=libpthread.a',
    ]);
    expect(readFileSync(join(dir, 'libstdc++.a'), 'utf8')).toBe('!<arch>\nlibstdc++');
    expect(readFileSync(join(dir, 'libpthread.a'), 'utf8')).toBe('!<arch>\npthread');
    // glibc links its C++ runtime dynamically: no folder; a compiler with none of them: no folder either
    expect(
      beforeFfmpeg(
        { depsDir: root, work, buildPlan: { setup: 'linux', platform: 'linux-x64' }, env: {} },
        root,
        [],
        run,
      ),
    ).toEqual([]);
    expect(
      beforeFfmpeg(
        {
          depsDir: root,
          work: join(root, 'other'),
          buildPlan: { setup: 'linux-musl', platform: 'linux-musl-x64' },
          env: {},
        },
        root,
        [],
        (_c, args) => `${args[0]!.slice('-print-file-name='.length)}\n`,
      ),
    ).toEqual([]);
  });
});
