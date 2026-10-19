#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command, CommanderError } from 'commander';

import { BuildError } from './build/docker.ts';
import { bundleApple } from './bundle-apple.ts';
import { bundle, BundleError } from './bundle.ts';
import { CacheBusyError } from './cache-admin.ts';
import { exitCodeFor, expectErrors, formatError } from './cli-errors.ts';
import { runTargetBuild } from './commands/build.ts';
import {
  runCacheClear,
  runCacheList,
  runCachePath,
  runCachePrune,
  runCacheVerify,
} from './commands/cache.ts';
import { realDoctorEnv, runDoctor, vulkanShaders } from './commands/doctor.ts';
import { runFolderLockOrUpdate, runFolderOutdated } from './commands/folder-versions.ts';
import {
  FolderError,
  hasFolder,
  openFolder,
  runFolderCheck,
  runFolderEdit,
  runFolderInit,
  runFolderMissing,
  runFolderPlan,
  runShow,
  runShowHas,
  runTargets,
} from './commands/folder.ts';
import { runMigrate } from './commands/migrate.ts';
import { runOptions } from './commands/options.ts';
import { runRecipeCheck } from './commands/recipe-check.ts';
import { runReleases } from './commands/releases.ts';
import { takeTestEnv } from './commands/test-env.ts';
import { runTest } from './commands/test.ts';
import { UpstreamFailure, WriteError } from './commands/versions.ts';
import { EngineDataError, loadEngineData } from './engine-data.ts';
import { FetchError, fetchRelease, updatePin } from './fetch.ts';
import { selectionFrom } from './folder-init.ts';
import { Interrupted } from './interrupt.ts';
import { LOCK_FILE, LockError, readFolderLock } from './lockfile.ts';
import { ManifestError, parseManifest } from './manifest.ts';
import { dataRoot, packageRoot, packageVersion } from './paths.ts';
import { EditError } from './profile-edit.ts';
import { readPlainFile } from './read-file.ts';
import { selectedNames } from './select.ts';
import { GitMissingError } from './upstream.ts';

import type { Folder, Target } from './targets.ts';

class UsageError extends Error {}

/** Where the user's arguments start in process.argv (after node and this script). */
const FIRST_ARG = 2;

/** Output nobody needs to see. */
const ignore = (): void => undefined;

/** Sets the exit code the process ends with. */
function setExitCode(code: number): void {
  process.exitCode = code;
}

// `pnpm run dev <command>` runs in the engine's own folder; INIT_CWD is where it was typed, the folder meant
if (process.env['npm_lifecycle_event'] === 'dev' && process.env['INIT_CWD']) {
  process.chdir(process.env['INIT_CWD']);
}

// the errors the commands throw for the user to read (exit 2 unless they carry their own code)
expectErrors(
  UsageError,
  EngineDataError,
  UpstreamFailure,
  GitMissingError,
  LockError,
  WriteError,
  BuildError,
  EditError,
  FolderError,
  BundleError,
  ManifestError,
  CacheBusyError,
  FetchError,
  Interrupted,
);

/** What a command returns: its result (stdout), its exit code, and notes for the user (stderr). */
interface Result {
  output: string;
  exitCode: number;
  notes?: string[];
}

/**
 * Runs a command: its result goes to stdout, its notes and any error to stderr (with --json, an error is
 * {"error": ...} on stdout). The exit code is the result's, or the error's (exitCodeFor).
 */
async function run(fn: () => Result | Promise<Result>): Promise<void> {
  // --json is only an option of the commands that print JSON
  const json = process.argv.slice(FIRST_ARG).includes('--json');
  try {
    const { output, exitCode, notes } = await fn();
    for (const note of notes ?? []) {
      console.error(note);
    }
    console.log(output);
    setExitCode(exitCode);
  } catch (e) {
    report(e, json);
  }
}

/** Reports a failure: {"error": ...} on stdout with --json, else one line on stderr; the exit code is the error's. */
function report(e: unknown, json: boolean): void {
  const text = formatError(e, { json, debug: process.env['FFMPEG_BUILD_DEBUG'] === '1' });
  if (json) {
    console.log(text);
  } else {
    console.error(text);
  }
  process.exitCode = exitCodeFor(e);
}

/** Why a file couldn't be read, in a few words. */
function readFailure(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return 'no such file';
  }
  if (code === 'EISDIR') {
    return 'a folder, not a file';
  }
  return (e as Error).message;
}

/** A file the user named, read; a usage error (exit 2) naming the option when it can't be. */
function readText(path: string, option: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`${option} ${path}: ${readFailure(e)}`);
  }
}

const data = () => loadEngineData(dataRoot());
const only = (target?: string) => (target ? { target } : {});
// --target <names> and --platform <patterns>: the targets a command works on (comma-separated lists)
const TARGETS = ['--target <names>', 'only these targets (comma-separated)'] as const;
const PLATFORMS_OPT = [
  '--platform <patterns>',
  "only targets on these platforms, e.g. 'linux-*,win-x64'",
] as const;
interface Chosen {
  target?: string;
  platform?: string;
}
const chosen = (folder: Folder, opts: Chosen) =>
  selectedNames(folder, {
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  });
/** The chosen target names; a command that makes things (build, test) needs a choice rather than taking everything. */
const chosenOrAsk = (folder: Folder, opts: Chosen, verb: string): string[] => {
  const names = chosen(folder, opts).target;
  if (!names) {
    throw new UsageError(
      `say what to ${verb}: --target <names> or --platform <patterns> (\`ffmpeg-build targets\` lists them)`,
    );
  }
  return names.split(',');
};
/** Runs a command per target in turn: their outputs together, the worst exit code; stops at the first that fails. */
async function each(
  names: string[],
  one: (target: string) => Result | Promise<Result>,
): Promise<Result> {
  const outputs: string[] = [];
  for (const name of names) {
    const r = await one(name);
    if (r.output) {
      outputs.push(r.output);
    }
    if (r.exitCode) {
      return { output: outputs.join('\n'), exitCode: r.exitCode };
    }
  }
  return { output: outputs.join('\n'), exitCode: 0 };
}

const program = new Command('ffmpeg-build')
  .description(
    'Build FFmpeg your way: ffmpeg-build.yml lists the builds (targets) and what each gets',
  )
  .version(packageVersion())
  // commander's own failures (an unknown option or command, a missing argument) are thrown, not printed, and
  // reported below like any command's usage error; the subcommands inherit both settings
  .exitOverride()
  .configureOutput({ outputError: ignore });

program
  .command('init')
  .description(
    'write ffmpeg-build.yml from the shipped targets, narrowed to the licenses, platforms and FFmpeg you build',
  )
  .option('--license <list>', 'licenses to build (required), e.g. lgplv3,gplv3, or all')
  .option('--platforms <list>', 'platforms to build (required), e.g. linux-x64,win-*, or all')
  .option(
    '--ffmpeg <list>',
    'FFmpeg series to build, e.g. 9 or 8,9 or latest (default: the newest)',
  )
  .option('--from <shipped>', 'the shipped targets to start from', 'devenvy')
  .option('--empty', 'bare targets: add what you want with `profile add --to`')
  .action(
    async (opts: {
      license?: string;
      platforms?: string;
      ffmpeg?: string;
      from: string;
      empty?: boolean;
    }) =>
      run(() =>
        runFolderInit(
          { ...selectionFrom(opts), ...(opts.empty ? { empty: true } : {}) },
          opts.from,
          data(),
        ),
      ),
  );

program
  .command('migrate')
  .description(
    'turn the old matrix profiles here (and ffmpeg.lock) into ffmpeg-build.yml and one lock; keeps the old files as *.old',
  )
  .action(async () => run(() => runMigrate(data())));

program
  .command('check')
  .description('is every target possible? (offline)')
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean } & Chosen) =>
    run(() => {
      const folder = openFolder();
      return runFolderCheck(folder, data(), { json: opts.json === true, ...chosen(folder, opts) });
    }),
  );

program
  .command('doctor')
  .description(
    'is this machine ready to build (and test) these targets? what each needs, and how to install what is missing (offline)',
  )
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean } & Chosen) =>
    run(() => {
      const d = data();
      // without ffmpeg-build.yml, for the platforms --platform names
      const folder = hasFolder() ? openFolder() : undefined;
      return runDoctor(
        {
          ...(folder ? { folder, shaders: (t: Target) => vulkanShaders(folder, t, d) } : {}),
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
          json: opts.json === true,
        },
        realDoctorEnv(d, packageRoot),
      );
    }),
  );

program
  .command('plan')
  .description('what each target builds: options and libraries (offline)')
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean } & Chosen) =>
    run(() => {
      const folder = openFolder();
      return runFolderPlan(folder, data(), { json: opts.json === true, ...chosen(folder, opts) });
    }),
  );

program
  .command('show')
  .description(
    'what one target gets, and from which base; or with --has, which targets get something (offline)',
  )
  .argument('[target]', 'the target (or --target)')
  .option('--target <name>', 'the target, as the other commands take it')
  .option('--has <name>', 'which targets get this option, and why the others do not')
  .option('--json', 'machine-readable output')
  .action(
    async (
      positional: string | undefined,
      opts: { target?: string; has?: string; json?: boolean },
    ) =>
      run(() => {
        const folder = openFolder();
        if (opts.has) {
          return runShowHas(folder, data(), opts.has, opts.json === true);
        }
        if (positional && opts.target && positional !== opts.target) {
          throw new UsageError(`name one target: ${positional} or --target ${opts.target}`);
        }
        const target = positional ?? opts.target;
        if (!target) {
          throw new UsageError(
            'name a target (`ffmpeg-build targets` lists them), or pass --has <name>',
          );
        }
        return runShow(folder, data(), target, opts.json === true);
      }),
  );

program
  .command('targets')
  .description(
    "the folder's targets: platform, license, FFmpeg series (and its locked release); --json for CI matrices",
  )
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean } & Chosen) =>
    run(() => {
      const folder = openFolder();
      return runTargets(folder, opts.json === true, chosen(folder, opts).target);
    }),
  );

program
  .command('lock')
  .description(
    'write ffmpeg.lock: keep what is locked, look up only what is missing or no longer allowed',
  )
  .action(async () =>
    run(async () => runFolderLockOrUpdate(openFolder(), data(), { mode: 'keep' })),
  );

program
  .command('update')
  .description('move ffmpeg.lock to the newest versions the targets allow (asks upstream)')
  .option('--summary <file>', 'also write the update PR text to this file')
  .action(async (opts: { summary?: string }) =>
    run(async () =>
      runFolderLockOrUpdate(openFolder(), data(), {
        mode: 'update',
        ...(opts.summary ? { summary: opts.summary } : {}),
      }),
    ),
  );

program
  .command('outdated')
  .description('what is newer upstream, and what update would do (read-only)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) =>
    run(async () => runFolderOutdated(openFolder(), data(), { json: opts.json === true })),
  );

program
  .command('test')
  .description(
    "run a target's build: a smoke test, then its tests: scripts (where this machine can run it; a library build: link a program against it, and run that where it can)",
  )
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--dist <dir>', 'where it was built (build --out)', 'dist')
  .option(
    '--must-run',
    "fail, instead of skipping, a build this machine can't run (CI, on the runner meant to run it)",
  )
  .action(async (opts: { dist: string; mustRun?: boolean } & Chosen) =>
    run(async () => {
      // build.yml's test-env secret: out of this process's environment before anything starts, masked on GitHub
      const testEnv = takeTestEnv(process.env, (line) => {
        process.stdout.write(`${line}\n`);
      });
      const folder = openFolder();
      return each(chosenOrAsk(folder, opts, 'test'), async (target) =>
        runTest(folder, data(), {
          target,
          dist: opts.dist,
          mustRun: opts.mustRun === true,
          testEnv,
        }),
      );
    }),
  );

program
  .command('releases')
  .description(
    'the releases: next tag, whether each is due (changed since its last release) and why, targets and runners',
  )
  .option('--due', 'only the releases that are due')
  .option('--offline', "don't look up the last releases (every release counts as new)")
  .option('--json', 'machine-readable output (the CI build matrix)')
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option(
    '--whole',
    'refuse a release the choice leaves part-built (CI, before publishing: a release is published with all its targets)',
  )
  .action(
    async (opts: { due?: boolean; offline?: boolean; json?: boolean; whole?: boolean } & Chosen) =>
      run(async () => {
        const folder = openFolder();
        return runReleases(folder, data(), {
          due: opts.due === true,
          offline: opts.offline === true,
          json: opts.json === true,
          whole: opts.whole === true,
          ...chosen(folder, opts),
        });
      }),
  );

program
  .command('bundle')
  .description(
    "write a release's sources archive, manifest.yml, SHA256SUMS and release notes beside its built targets",
  )
  .requiredOption(
    '--release <tag>',
    'the release, e.g. 9.0.2.3 (`ffmpeg-build releases` says which is next)',
  )
  .option('--dist <dir>', 'where the targets were built (build --out)', 'dist')
  .option('--previous <manifest>', "the last release's manifest.yml (default: looked up on GitHub)")
  .option(
    '--apple',
    "on a Mac: make each licence's iOS / Mac Catalyst xcframework bundle (ffmpeg-<v>-ios-<license>.tar.gz) from its four framework builds",
  )
  .action(async (opts: { release: string; dist: string; previous?: string; apple?: boolean }) =>
    run(async () => {
      const folder = openFolder();
      const lock = readFolderLock(join(folder.dir, LOCK_FILE));
      if (!lock) {
        throw new UsageError(`no ${LOCK_FILE} here; run ffmpeg-build lock first`);
      }
      if (opts.apple) {
        const r = await bundleApple(folder, data(), lock, {
          tag: opts.release,
          dist: opts.dist,
          engineRoot: packageRoot,
        });
        return { output: `${opts.release}: ${r.assets.join(', ')}`, exitCode: 0 };
      }
      const previous = opts.previous
        ? parseManifest(readText(opts.previous, '--previous'), opts.previous)
        : undefined;
      const r = await bundle(folder, data(), lock, {
        tag: opts.release,
        dist: opts.dist,
        engineRoot: packageRoot,
        ...(previous ? { previous } : {}),
      });
      return {
        output: `${r.tag}: ${r.assets.join(', ')}${r.latest ? ' (latest)' : ''}`,
        exitCode: 0,
        notes: r.notes,
      };
    }),
  );

program
  .command('build')
  .description('build targets (--target or --platform), each in its pinned toolchain')
  .option(...TARGETS)
  .option(...PLATFORMS_OPT)
  .option('--out <dir>', 'where the archives go', 'dist')
  .option(
    '--in <where>',
    "docker: in the platform's pinned image; here: natively on this machine (default: ffmpeg-build.yml's build: section, else Docker, or Xcode for Apple)",
  )
  .option('--dry-run', 'say what would be built, and in which toolchain, without building')
  .option(
    '--only <recipes>',
    'build just these libraries (and what they need), without FFmpeg: a recipe check',
  )
  .action(async (opts: { out: string; dryRun?: boolean; only?: string; in?: string } & Chosen) =>
    run(async () => {
      const folder = openFolder();
      const recipes = opts.only
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.in !== undefined && opts.in !== 'docker' && opts.in !== 'here') {
        throw new UsageError(`--in takes docker or here, not ${opts.in}`);
      }
      const where = opts.in;
      return each(chosenOrAsk(folder, opts, 'build'), async (target) =>
        runTargetBuild(folder, target, data(), {
          out: opts.out,
          dryRun: opts.dryRun === true,
          ...(recipes ? { only: recipes } : {}),
          ...(where ? { in: where } : {}),
        }),
      );
    }),
  );

program
  .command('recipe-check')
  .description(
    "build recipes (and what builds against them) on every platform they claim, without FFmpeg, at the canary lock's versions: what CI does for a recipe change",
  )
  .argument('<recipes...>', 'the recipes, e.g. zlib libpng')
  .option('--platform <patterns>', "only these platforms, e.g. 'linux-*,win-x64'")
  .option('--plan', 'write the folder and say what would build where, without building')
  .option('--json', 'machine-readable output (with --plan: the CI matrix)')
  .option('--lock <file>', "the lock whose versions to build (default: the engine's canary lock)")
  .option(
    '--dir <dir>',
    'the folder to write the check targets to (default: a temporary one); one written for the same recipes is reused',
  )
  .option('--out <dir>', 'where the build logs go (default: <dir>/dist)')
  .option('--in <where>', 'docker or here, as build takes it')
  .option('--dry-run', 'say what would be built, without building')
  .action(
    async (
      names: string[],
      opts: {
        platform?: string;
        plan?: boolean;
        json?: boolean;
        lock?: string;
        dir?: string;
        out?: string;
        in?: string;
        dryRun?: boolean;
      },
    ) =>
      run(async () => {
        if (opts.in !== undefined && opts.in !== 'docker' && opts.in !== 'here') {
          throw new UsageError(`--in takes docker or here, not ${opts.in}`);
        }
        const where = opts.in;
        return runRecipeCheck(data(), names, {
          ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
          ...(opts.lock !== undefined ? { lock: opts.lock } : {}),
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
          ...(opts.out !== undefined ? { out: opts.out } : {}),
          ...(where ? { in: where } : {}),
          plan: opts.plan === true,
          json: opts.json === true,
          dryRun: opts.dryRun === true,
        });
      }),
  );

program
  .command('fetch')
  .description(
    'download a published build (owner/repo@tag, or a file holding it), check its sha256, unpack it',
  )
  .argument('[pin]', 'owner/repo@tag, or a pin file such as ffmpeg.version')
  .option('--target <name>', 'the target to take from the release')
  .option('--platform <platform>', 'or the platform, when the release has one target for it')
  .option('--dev', 'also unpack the dev archive (headers, import libraries, pkg-config files)')
  .option('--out <dir>', 'where to unpack (replaced whole)', 'ffmpeg')
  .option(
    '--update <pin-file>',
    'move the pin file to the newest release of the same group and FFmpeg major',
  )
  .action(
    async (
      pin: string | undefined,
      opts: { target?: string; platform?: string; dev?: boolean; out: string; update?: string },
    ) =>
      run(async () => {
        const sel = {
          ...(opts.target ? { target: opts.target } : {}),
          ...(opts.platform ? { platform: opts.platform } : {}),
        };
        if (opts.update) {
          const change = await updatePin(opts.update, sel);
          return {
            output:
              change ?? `${opts.update}: up to date (${readFileSync(opts.update, 'utf8').trim()})`,
            exitCode: 0,
          };
        }
        if (!pin) {
          throw new UsageError(
            'say what to fetch: owner/repo@tag, or a pin file (e.g. ffmpeg.version)',
          );
        }
        // a pin file's text, or the argument itself (owner/repo@tag)
        const text = readPlainFile(pin) ?? pin;
        return {
          output: await fetchRelease(text, { ...sel, dev: opts.dev === true }, opts.out),
          exitCode: 0,
        };
      }),
  );

program
  .command('options')
  .description("what a target can list, with each one's library, licenses and platforms (offline)")
  .option('--ffmpeg <major>', 'the FFmpeg major (default: the newest)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { ffmpeg?: string; json?: boolean }) =>
    run(() => runOptions(opts.ffmpeg, data(), opts.json === true)),
  );

program
  .command('guide')
  .description('how to use ffmpeg-build, step by step (for people, scripts and AI agents)')
  .action(async () =>
    run(() => ({
      output: readFileSync(join(packageRoot, 'docs', 'getting-started.md'), 'utf8').trimEnd(),
      exitCode: 0,
    })),
  );

const cacheCmd = program
  .command('cache')
  .description(
    'the library cache (FFMPEG_BUILD_CACHE, else ~/.cache/ffmpeg-build): where it is, what it holds, and tidying it',
  );

cacheCmd
  .command('path')
  .description('print the cache folder')
  .action(async () => run(() => runCachePath()));

cacheCmd
  .command('list')
  .description('the cached libraries: version, size and when last used')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) =>
    run(async () => runCacheList({ json: opts.json === true })),
  );

cacheCmd
  .command('verify')
  .description(
    "check every entry's source record, and that its kept source matches its sha256 (exit 1 when any is bad)",
  )
  .option(
    '--fix',
    'remove the bad entries (the next build builds them again); waits for no build: refuses while one runs',
  )
  .action(async (opts: { fix?: boolean }) =>
    run(async () => runCacheVerify({ fix: opts.fix === true })),
  );

cacheCmd
  .command('prune')
  .description(
    'remove entries and sources not used recently, and what crashed runs left (refuses while a build runs)',
  )
  .option('--older-than <days>', 'not used for this many days', '30')
  .action(async (opts: { olderThan: string }) =>
    run(async () => runCachePrune({ olderThan: opts.olderThan })),
  );

cacheCmd
  .command('clear')
  .description('empty the cache (refuses while a build runs)')
  .action(async () => run(() => runCacheClear()));

const profileCmd = program
  .command('profile')
  .description(
    'edit ffmpeg-build.yml in place, keeping its comments (checks every target an edit reaches)',
  );

profileCmd
  .command('add')
  .description('add options to a base (every target using it) or to one target')
  .argument('<names...>', 'what to add, e.g. x265 srt')
  .option('--to <base or target>', 'the base or target to add to')
  .action(async (names: string[], opts: { to?: string }) =>
    run(() => {
      const folder = openFolder();
      if (!opts.to) {
        throw new UsageError(
          `say where to add: --to <base or target> (bases: ${Object.keys(folder.bases).join(', ') || 'none'}; \`ffmpeg-build targets\` lists the targets)`,
        );
      }
      return runFolderEdit('add', names, opts.to, data());
    }),
  );

profileCmd
  .command('remove')
  .description(
    'remove options from a base, or from one target (a target turns down what a base gives it)',
  )
  .argument('<names...>', 'what to remove')
  .option('--from <base or target>', 'the base or target to remove from')
  .action(async (names: string[], opts: { from?: string }) =>
    run(() => {
      openFolder();
      if (!opts.from) {
        throw new UsageError('say where to remove from: --from <base or target>');
      }
      return runFolderEdit('remove', names, opts.from, data());
    }),
  );

profileCmd
  .command('missing')
  .description('what targets could add but neither list nor turn down (exit 1 when there is any)')
  .option('--target <name>', 'only this target')
  .option('--json', 'machine-readable output')
  .action(async (opts: { target?: string; json?: boolean }) =>
    run(() =>
      runFolderMissing(openFolder(), data(), { json: opts.json === true, ...only(opts.target) }),
    ),
  );

try {
  await program.parseAsync();
} catch (e) {
  if (!(e instanceof CommanderError)) {
    throw e;
  }
  // --help and --version have printed what was asked: exit 0. Commander's help shown for a missing subcommand
  // (already on stderr) and its parse errors are usage errors (2), never commander's own 1 (a target problem).
  const json = process.argv.slice(FIRST_ARG).includes('--json');
  if (e.exitCode === 0) {
    process.exitCode = 0;
  } else if (e.code === 'commander.help') {
    report(new UsageError('say which command (`ffmpeg-build --help` lists them)'), json);
  } else {
    report(new UsageError(e.message.replace(/^error: /, '').replace(/\s*\n\s*/g, ' ')), json);
  } // one line
}
