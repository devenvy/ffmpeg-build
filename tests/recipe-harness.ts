// Runs a recipe's build in library.ts against a fake source tree, with the process runner stubbed (vi.mock of
// src/build/run.ts in the test file) so every command is recorded instead of run.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { vi } from 'vitest';

import { type BuildContext, runRecipe } from '../src/build/library.ts';
import { run } from '../src/build/run.ts';
import { createToolchain } from '../src/build/toolchain.ts';
import { type EngineData, loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { expandPlatforms } from '../src/platforms.ts';

import type { Recipe } from '../src/schema/engine.ts';

let data: EngineData | undefined;
function engineData(): EngineData {
  data ??= loadEngineData(packageRoot);
  return data;
}

export function recipe(name: string): Recipe {
  const found = engineData().recipes.get(name);
  if (!found) {
    throw new Error(`no recipe ${name}`);
  }
  return found;
}

/** The platforms a recipe builds on. */
export function platformsOf(name: string): string[] {
  return expandPlatforms(recipe(name).platforms);
}

interface Call {
  command: string;
  args: string[];
  cwd: string; // relative to the source folder ('' for the source folder itself)
  env: Record<string, string | null>; // what differs from the recipe's environment (null: unset)
  capture: boolean;
}

export interface Harness {
  platform: string;
  root: string;
  src: string;
  deps: string;
  context: BuildContext;
  /** The environment every command of the recipe starts from: the toolchain's plus what the engine exports. */
  base: NodeJS.ProcessEnv;
  calls: Call[];
  /** What a command does when it "runs": write files, return output. */
  onRun: (call: Call) => string | undefined;
  read: (path: string) => string;
  write: (path: string, text: string) => void;
  /** Every file under a folder, relative to it, sorted. */
  files: (dir: string) => string[];
}

const BASE_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/builder', ANDROID_NDK_HOME: '/opt/ndk' };

/** A fake build of one platform: folders under a temp dir, the platform's real toolchain environment (xcrun stubbed). */
export function harness(
  platform: string,
  options: { version?: string; env?: Record<string, string>; path?: string } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'ffb-recipe-'));
  const src = join(root, 'work', 'src', 'lib');
  const deps = join(root, 'deps');
  const work = join(root, 'work');
  for (const dir of [src, join(deps, 'include'), join(deps, 'lib', 'pkgconfig')]) {
    mkdirSync(dir, { recursive: true });
  }
  const setup = engineData().platforms.get(platform)!.setup;
  const toolchain = createToolchain({
    platform,
    setup,
    depsDir: deps,
    work,
    engine: packageRoot,
    env: { ...BASE_ENV, ...options.env },
    command: (_command, args) =>
      args.includes('--show-sdk-path')
        ? `/sdk/${String(args[1])}`
        : `/xcode/${String(args.at(-1))}`,
  });
  // a PATH this machine can search (the toolchain's is for the image)
  if (options.path !== undefined) {
    toolchain.env['PATH'] = options.path;
  }
  const context: BuildContext = {
    plan: join(root, 'plan.json'),
    recipes: join(packageRoot, 'recipes'),
    engine: packageRoot,
    cache: join(root, 'cache'),
    out: join(root, 'out'),
    depsDir: deps,
    work,
    sources: join(root, 'sources'),
    jobs: 4,
    env: toolchain.env,
    toolchain,
    buildPlan: { platform, setup } as BuildContext['buildPlan'],
  };
  const version = options.version ?? '1.2.3';
  const base: NodeJS.ProcessEnv = {
    ...toolchain.env,
    RECIPES: context.recipes,
    ENGINE: context.engine,
    SETUP: setup,
    SRC_DIR: src,
    VERSION: version,
    DEPS_DIR: deps,
    BUILD_RID: platform,
    JOBS: '4',
    PKG_CONFIG_PATH: join(deps, 'lib', 'pkgconfig'),
  };
  const h: Harness = {
    platform,
    root,
    src,
    deps,
    context,
    base,
    calls: [],
    onRun: () => undefined,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, text) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    },
    files: (dir) => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) {
            walk(p);
          } else {
            out.push(relative(dir, p).replaceAll('\\', '/'));
          }
        }
      };
      walk(dir);
      return out.sort();
    },
  };
  vi.mocked(run).mockReset();
  vi.mocked(run).mockImplementation(async (command, args, opts = {}) => {
    const env: Record<string, string | null> = {};
    const callEnv = opts.env ?? {};
    for (const key of new Set([...Object.keys(callEnv), ...Object.keys(base)])) {
      if (callEnv[key] !== base[key]) {
        env[key] = callEnv[key] ?? null;
      }
    }
    const call: Call = {
      command,
      args: [...args],
      cwd: relative(src, opts.cwd ?? src).replaceAll('\\', '/'),
      env,
      capture: Boolean(opts.capture),
    };
    h.calls.push(call);
    return h.onRun(call) ?? '';
  });
  return h;
}

/** Runs the named recipe's build (bootstrap, before, steps or system, after) in the harness. */
export async function build(h: Harness, name: string): Promise<void> {
  await runRecipe(h.context, { version: h.base['VERSION']!, build: recipe(name).build }, h.src);
}

/** The recorded commands as short lines, `cwd$ command args [env]`, easy to compare with what a bash script ran. */
export function commands(h: Harness): string[] {
  return h.calls.map((c) => {
    const env = Object.entries(c.env)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => (v === null ? `-${k}` : `${k}=${v}`));
    return `${c.cwd ? `${c.cwd}$ ` : ''}${[c.command, ...c.args].join(' ')}${env.length ? ` [${env.join(' ')}]` : ''}`;
  });
}

/** What the standard systems run (the old engine's cmake_build / meson_build / autotools helper did the same). */
export function cmakeLines(h: Harness, args: string[], source = '.'): string[] {
  return [
    [
      'cmake',
      '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
      '-B',
      '_build',
      '-S',
      source,
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_INSTALL_PREFIX=${h.deps}`,
      '-DCMAKE_INSTALL_LIBDIR=lib',
      `-DCMAKE_PREFIX_PATH=${h.deps}`,
      '-DBUILD_SHARED_LIBS=OFF',
      '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
      ...h.context.toolchain.cmakeArgs,
      ...args,
    ].join(' '),
    'cmake --build _build -j4',
    'cmake --install _build',
  ];
}

export function mesonLines(h: Harness, args: string[], source = '.'): string[] {
  return [
    [
      'meson',
      'setup',
      '_build',
      source,
      `--prefix=${h.deps}`,
      '--libdir=lib',
      '--default-library=static',
      '--buildtype=release',
      ...h.context.toolchain.mesonArgs,
      ...args,
    ].join(' '),
    'meson compile -C _build -j 4',
    'meson install -C _build',
  ];
}

/** The standard autotools configure: the prefix, the recipe's args, the cross triple last (as every old build.sh). */
export function configureLine(h: Harness, args: string[], env = ''): string {
  const host = h.context.env['CROSS_HOST'];
  return (
    [`./configure --prefix=${h.deps}`, ...args, ...(host ? [`--host=${host}`] : [])].join(' ') + env
  );
}

export function pcPath(h: Harness, name: string): string {
  return join(h.deps, 'lib', 'pkgconfig', `${name}.pc`);
}
