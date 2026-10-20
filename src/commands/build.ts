import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  currentHost,
  DOCTOR_HINT,
  type Host,
  hostFacts,
  installHint,
  missingTools,
  nativeKind,
  nativeTools,
} from '../build/host.ts';
import { buildModules, workerPath } from '../build/modules.ts';
import {
  acquireBuildLock,
  hostEnv,
  hostToolchainIdentity,
  nativeEnv,
  nativePaths,
  nativePreflight,
  nativeWorkRoot,
} from '../build/native.ts';
import {
  type BuildPlan,
  type BuildSource,
  makeBuildPlan,
  toolchainIdentity,
} from '../build/plan.ts';
import { beginOutputs, type OutputSet } from '../build-outputs.ts';
import { type BuildIn, buildSettings, defaultIn, isApple } from '../build-settings.ts';
import { artifactName, type Folder, FOLDER_FILE, symbolsName, targetProfile } from '../targets.ts';
import { FolderError, folderErrors, folderExitCode, runFolderCheck } from './folder.ts';
import {
  BuildError,
  containerCleanup,
  dockerCommand,
  dockerRunArgs,
  dockerStatus,
  ensureImage,
  runStreaming,
} from '../build/docker.ts';
import {
  cacheRoot,
  cleanTemps,
  liveBuilds,
  registerBuild,
  touchEntries,
  touchKeptSources,
} from '../cache-admin.ts';
import { BuildFailure, CliError, type ExitCode } from '../cli-errors.ts';
import { depsOn, type EngineData } from '../engine-data.ts';
import { FetchError, repoIsPrivate, repoIsPrivateByGit } from '../fetch.ts';
import { LockBusyError } from '../file-lock.ts';
import { Interrupted, withInterrupts } from '../interrupt.ts';
import { LOCK_FILE, type LockedProfile, readFolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { displayPath, type Profile } from '../profile.ts';
import { publishingRepo } from '../release-remote.ts';
import { type CellPlan, planProfile } from '../resolve.ts';
import { JSON_INDENT } from '../text.ts';

import type { PlatformEntry } from '../schema/engine.ts';

/** A remote URL as a reader can open it: no credentials, and scp-style `git@host:path` as https. */
export function publicRepoUrl(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp) {
    return `https://${scp[1]!}/${scp[2]!.replace(/\.git$/, '')}`;
  }
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\.git$/, '');
  } catch {
    return url;
  }
}

/** An environment setting, with an empty one counting as unset. */
const setting = (value: string | undefined): string | undefined =>
  value === '' ? undefined : value;

/** Whether a git remote is something a reader can fetch: a URL (scheme://) or scp-style host:path, not a local path. */
function isRemoteUrl(remote: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
    ? !/^file:/i.test(remote)
    : /^[\w.-]+@[\w.-]+:(?!\/)/.test(remote);
}

/**
 * The release a build ships in (FFMPEG_BUILD_RELEASE, set by the build workflow), the repository it is published in,
 * and whether that repository is private: a private one's notices make a written offer of the source, since nobody
 * outside it can open a link into it. Never guessed: unreadable visibility fails the build.
 */
export async function releaseIdentity(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ release?: string; repository?: string; privateRepo?: boolean }> {
  const release = setting(env['FFMPEG_BUILD_RELEASE']);
  if (!release) {
    return {};
  }
  const repository = setting(env['GITHUB_REPOSITORY']) ?? publishingRepo(dir);
  if (!repository) {
    return { release };
  }
  // CI reads it once for the whole release (build.yml's plan job): each build asking GitHub on its own runs an
  // unauthenticated runner past its rate limit
  const given = setting(env['FFMPEG_BUILD_REPO_PRIVATE']);
  if (given !== undefined) {
    if (given !== 'true' && given !== 'false') {
      throw new CliError(`FFMPEG_BUILD_REPO_PRIVATE is "${given}": expected true or false`);
    }
    return { release, repository, privateRepo: given === 'true' };
  }
  // the run's event names it (push, pull_request, workflow_dispatch; a workflow_call has its caller's): no request.
  // A schedule's names no repository
  const fromEvent = eventSaysPrivate(env, repository);
  if (fromEvent !== undefined) {
    return { release, repository, privateRepo: fromEvent };
  }
  // with a token, the API; without one, git's smart HTTP first: the API refuses an unauthenticated runner past its
  // rate limit (60 an hour for the address, which a hosted runner shares), as it did devenvy/ffmpeg's 0.0.12 builds
  const ask = async (): Promise<boolean> => {
    if (setting(env['GITHUB_TOKEN']) ?? setting(env['GH_TOKEN'])) {
      return repoIsPrivate(repository);
    }
    try {
      return await repoIsPrivateByGit(
        setting(env['GITHUB_SERVER_URL']) ?? 'https://github.com',
        repository,
      );
    } catch (e) {
      if (!(e instanceof FetchError)) {
        throw e;
      }
      return repoIsPrivate(repository);
    }
  };
  try {
    return { release, repository, privateRepo: await ask() };
  } catch (e) {
    if (!(e instanceof FetchError)) {
      throw e;
    }
    throw new CliError(
      `can't read whether ${repository} is private, which decides where its notices say the source is: ${e.message}`,
      e.exitCode,
    );
  }
}

/** `repository.private` of the GitHub Actions event payload (GITHUB_EVENT_PATH), when it is about `repository`. */
function eventSaysPrivate(env: NodeJS.ProcessEnv, repository: string): boolean | undefined {
  const path = setting(env['GITHUB_EVENT_PATH']);
  if (!path) {
    return undefined;
  }
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const repo = (event as { repository?: { full_name?: unknown; private?: unknown } } | null)
    ?.repository;
  return typeof repo?.full_name === 'string' &&
    repo.full_name.toLowerCase() === repository.toLowerCase() &&
    typeof repo.private === 'boolean'
    ? repo.private
    : undefined;
}

/**
 * The repository and commit THIRD-PARTY-NOTICES.txt names: FFMPEG_BUILD_SOURCE_REPO / _REF (CI sets them), else the
 * folder's git remote (origin, when it is a URL rather than a local path) and HEAD, with -dirty when tracked files
 * have changes HEAD doesn't hold. Missing ones are left out (the notices then say it wasn't recorded).
 */
export function sourceIdentity(dir: string, env: NodeJS.ProcessEnv = process.env): BuildSource {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim();
    } catch {
      return undefined;
    }
  };
  const remote = env['FFMPEG_BUILD_SOURCE_REPO'] ? undefined : git(['remote', 'get-url', 'origin']);
  const repo =
    setting(env['FFMPEG_BUILD_SOURCE_REPO']) ??
    (remote && isRemoteUrl(remote) ? remote : undefined);
  let ref = setting(env['FFMPEG_BUILD_SOURCE_REF']);
  if (!ref) {
    const head = git(['rev-parse', 'HEAD']);
    // tracked files only: the build's own output (dist/) is usually untracked
    if (head) {
      ref = git(['status', '--porcelain', '--untracked-files=no']) ? `${head}-dirty` : head;
    }
  }
  return { ...(repo ? { repo: publicRepoUrl(repo) } : {}), ...(ref ? { ref } : {}) };
}

export { cacheRoot };

interface Result {
  output: string;
  exitCode: number;
}

/** The platform's entry in platforms.yml, or why it can't be built here. */
function platformEntry(data: EngineData, platform: string): PlatformEntry | Result {
  const target = data.platforms.get(platform);
  if (!target) {
    throw new CliError(
      `building for ${platform} isn't supported yet (ffmpeg-build builds: ${[...data.platforms.keys()].join(', ')})`,
    );
  }
  return target;
}

interface Native {
  kind: 'apple' | 'linux' | 'windows';
}

/**
 * How a target builds: --in, else ffmpeg-build.yml's build: section, else the platform's usual way (Apple natively,
 * the rest in Docker). `here` needs a machine that builds the platform natively; Apple never builds in Docker.
 */
function howToBuild(
  folder: Folder,
  platform: string,
  wanted: BuildIn | undefined,
  host: Host,
): { in: 'docker' } | { in: 'here'; native: Native } | Result {
  const how = wanted ?? buildSettings(folder, platform).in ?? defaultIn(platform);
  if (how === 'docker') {
    if (isApple(platform)) {
      throw new CliError(
        `${platform} builds only on a Mac, with Xcode; it has no Docker build (drop --in docker)`,
      );
    }
    return { in: 'docker' };
  }
  const native = nativeKind(platform, host);
  if ('error' in native) {
    throw new CliError(native.error);
  }
  return { in: 'here', native };
}

/** Where a dry run says a build would happen. */
function buildPlace(how: { in: 'docker' } | { in: 'here'; native: Native }, image: string): string {
  if (how.in === 'docker') {
    return `in ffmpeg-build-${image}`;
  }
  return how.native.kind === 'apple' ? 'in Xcode on this Mac' : 'natively on this machine';
}

/** A plan without its FFmpeg build: build --only builds libraries alone. */
function withoutFfmpeg(plan: BuildPlan): BuildPlan {
  const copy = { ...plan };
  delete copy.ffmpeg;
  return copy;
}

/** Builds a target: its one build, named after it (see artifactName). */
/**
 * The libraries `only` names and everything they build against in this build, in build order: a recipe check builds
 * them without FFmpeg. Names this build doesn't have are an error.
 */
function onlyLibraries(data: EngineData, cell: CellPlan, only: string[]): string[] {
  const missing = only.filter((n) => !cell.recipes.includes(n));
  if (missing.length) {
    throw new FolderError(
      `this target doesn't build ${missing.join(', ')} (it builds ${cell.recipes.join(', ')})`,
    );
  }
  const keep = new Set<string>();
  const add = (n: string) => {
    if (keep.has(n)) {
      return;
    }
    keep.add(n);
    const r = data.recipes.get(n)!;
    for (const d of [
      ...depsOn(r, 'needs', cell.cell.platform),
      ...depsOn(r, 'uses', cell.cell.platform),
    ]) {
      if (cell.recipes.includes(d)) {
        add(d);
      }
    }
  };
  only.forEach(add);
  return cell.recipes.filter((n) => keep.has(n));
}

export async function runTargetBuild(
  folder: Folder,
  name: string,
  data: EngineData,
  options: { out: string; dryRun?: boolean; only?: string[]; in?: BuildIn; host?: Host },
): Promise<Result> {
  const t = folder.targets.find((x) => x.name === name);
  if (!t) {
    throw new FolderError(
      `no target ${name} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`,
    );
  }
  const entry = platformEntry(data, t.platform);
  if ('exitCode' in entry) {
    return entry;
  }
  const how = howToBuild(folder, t.platform, options.in, options.host ?? currentHost());
  if ('exitCode' in how) {
    return how;
  }
  const checked = runFolderCheck(folder, data, { target: name });
  if (checked.exitCode) {
    return checked;
  }
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const version = lock?.ffmpeg[t.ffmpeg];
  if (!lock || !version) {
    throw new CliError(`${LOCK_FILE} has no FFmpeg ${t.ffmpeg} yet; run ffmpeg-build lock first`);
  }
  // folder-wide problems (a pin no build can meet, a lock that no longer fits) stop every target's build
  const errors = folderErrors(folder, data, lock);
  // (a lock that no longer fits is a data problem, exit 2; the rest are the targets', exit 1)
  if (errors.length) {
    throw new CliError(
      [folder.file, ...errors.map((e) => `  ✗ ${e}`)].join('\n'),
      folderExitCode(errors) as ExitCode,
    );
  }
  const profile = targetProfile(folder, t);
  const [cell] = planProfile(profile, data, { [t.ffmpeg]: version }).cells;
  const buildName = artifactName(t, version);
  const only = options.only?.length ? onlyLibraries(data, cell!, options.only) : undefined;
  if (only && options.dryRun) {
    return {
      output: `would build ${only.join(', ')} for ${t.platform}, without FFmpeg`,
      exitCode: 0,
    };
  }
  if (options.dryRun) {
    return {
      output: `would build ${buildName} (${t.platform}) ${buildPlace(how, entry.image)}`,
      exitCode: 0,
    };
  }
  return withInterrupts(async () =>
    runJob(
      {
        platform: t.platform,
        target: entry,
        native: how.in === 'here' ? how.native : undefined,
        profile,
        locked: {
          ffmpeg: lock.ffmpeg,
          libraries: lock.libraries,
          pinned: [],
          ...(lock.pins ? { pins: lock.pins } : {}),
        },
        out: options.out,
        builds: [
          {
            cell: cell!,
            variant: t.name,
            name: buildName,
            ...(t.releaseGroup ? { group: t.releaseGroup } : {}),
            ...(only ? { only } : {}),
          },
        ],
      },
      data,
    ),
  );
}

interface Job {
  platform: string;
  target: PlatformEntry;
  native: Native | undefined; // --in here: on this machine, with its own toolchain; else in the platform's image
  profile: Profile;
  locked: LockedProfile;
  out: string;
  builds: { cell: CellPlan; variant: string; name?: string; group?: string; only?: string[] }[]; // only: these libraries, no FFmpeg
}

/** Runs the builds of one platform: in its toolchain image, or natively on a Mac. */
async function runJob(job: Job, data: EngineData): Promise<Result> {
  const { target, profile, locked } = job;
  const options = { platform: job.platform, out: job.out };
  const native = job.native !== undefined; // built on this machine (--in here), not in a toolchain image

  const docker = native ? 'ready' : await dockerStatus();
  if (docker === 'missing') {
    throw new CliError(
      `ffmpeg-build needs Docker to build ${options.platform}; install it (Docker Desktop on Windows/macOS) and try again (${DOCTOR_HINT})`,
    );
  }
  if (docker === 'stopped') {
    throw new CliError(
      `Docker is installed but not running; start it (Docker Desktop on Windows/macOS) and try again (${DOCTOR_HINT})`,
    );
  }

  const out = resolve(options.out);
  const libs = join(cacheRoot(), 'libs');
  mkdirSync(out, { recursive: true });
  mkdirSync(libs, { recursive: true });
  // images/ and platforms/ ship with the engine; recipes come from the data
  const workRoot = native ? nativeWorkRoot() : undefined;
  const paths = workRoot ? nativePaths(workRoot, options.platform) : undefined;
  if (workRoot) {
    if (job.native!.kind === 'apple') {
      nativePreflight();
    } else {
      const kind = job.native!.kind;
      const missing = missingTools(
        nativeTools(kind, options.platform, currentHost().msystem),
        hostEnv(),
      );
      if (missing.length) {
        throw new BuildError(
          `a native ${options.platform} build needs ${missing.join(', ')}; ${installHint(kind, currentHost(), missing)} (${DOCTOR_HINT})`,
        );
      }
    }
    mkdirSync(workRoot, { recursive: true });
  }
  // registered in the cache while it builds, so `cache prune`/`clear` leave it alone; and what crashed runs left in the
  // cache goes now (all of it when no other build is running, else only what is a day old)
  const registration = registerBuild(cacheRoot());
  cleanTemps(cacheRoot(), { all: liveBuilds(cacheRoot(), registration.path).length === 0 });
  const noLock = (): void => undefined;
  let release: () => void;
  try {
    release = workRoot ? acquireBuildLock(workRoot, options.platform) : noLock;
  } catch (e) {
    registration.release();
    throw e;
  }
  try {
    const image = native ? undefined : await ensureImage(packageRoot, target.image);
    // a native build's toolchain is this machine's: Xcode and Homebrew's tools on a Mac, the compiler and build tools'
    // versions on Linux and in MSYS2 (a toolchain upgrade rebuilds the libraries); in Docker, the image
    let toolchain: string;
    if (!paths) {
      toolchain = toolchainIdentity(packageRoot, image!.id, target.setup);
    } else if (job.native!.kind === 'apple') {
      toolchain = hostToolchainIdentity(packageRoot, target.setup, options.platform, paths.depsDir);
    } else {
      toolchain = toolchainIdentity(
        packageRoot,
        `host\0${hostFacts(job.native!.kind, options.platform, hostEnv())}\0${paths.depsDir}`,
        target.setup,
      );
    }
    const built: string[] = [];
    // what THIRD-PARTY-NOTICES.txt names as the source: the build's definition, and the release it ships in
    // (FFMPEG_BUILD_RELEASE, set by the build workflow) with the repository it is published in
    const folderDir = profile.dir ?? process.cwd();
    const source = sourceIdentity(folderDir);
    const published = await releaseIdentity(folderDir);
    for (const { cell, variant, name, group, only } of job.builds) {
      const full = makeBuildPlan({
        profile,
        data,
        locked,
        cell,
        imageId: toolchain,
        cacheDir: libs,
        variant,
        source,
        ...published,
        ...(group ? { group } : {}),
        ...(name ? { name } : {}),
        ...(paths ? { depsDir: paths.depsDir } : {}),
      });
      const plan = only
        ? { ...withoutFfmpeg(full), libraries: full.libraries.filter((l) => only.includes(l.name)) }
        : full;
      const planDir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-plan-'));
      const planPath = join(planDir, 'plan.json');
      const log = join(out, `${plan.name}.log`);
      // the build writes into a staging folder of its own inside --out; its outputs replace the previous ones only
      // when it succeeds (outputs.ts), and no other build of this artifact writes there meanwhile
      let outputs: OutputSet;
      try {
        outputs = beginOutputs(out, plan.name);
      } catch (e) {
        rmSync(planDir, { recursive: true, force: true });
        if (e instanceof LockBusyError) {
          throw new BuildError(
            [
              ...built,
              `another ffmpeg-build is already building ${plan.name} into ${displayPath(out)}${e.pid ? ` (pid ${e.pid})` : ''}; wait for it to finish`,
            ].join('\n'),
          );
        }
        throw e;
      }
      let result: { code: number; lastError?: string; signal?: 'SIGINT' | 'SIGTERM' };
      try {
        writeFileSync(planPath, JSON.stringify(plan, null, JSON_INDENT));
        if (paths) {
          // a container starts empty every time; a native build starts from empty folders instead
          rmSync(paths.depsDir, { recursive: true, force: true });
          rmSync(paths.work, { recursive: true, force: true });
          const env = nativeEnv({
            plan: planPath,
            recipes: join(data.root, 'recipes'),
            engine: join(packageRoot, 'platforms'),
            cache: cacheRoot(),
            out: outputs.staging,
            ...paths,
          });
          const how = job.native!.kind === 'apple' ? {} : { FFB_IN: 'here' }; // Linux and MSYS2 use their own compilers
          result = await runStreaming(
            process.execPath,
            [workerPath(packageRoot, buildModules(packageRoot))],
            outputs.log,
            { ...hostEnv(), ...env, ...how },
          );
        } else {
          const cidfile = join(planDir, 'container.id');
          const args = dockerRunArgs({
            tag: image!.tag,
            recipes: join(data.root, 'recipes'),
            engine: join(packageRoot, 'platforms'),
            package: packageRoot,
            cache: cacheRoot(),
            out: outputs.staging,
            plan: planPath,
            cidfile,
          });
          result = await runStreaming(
            dockerCommand(),
            args,
            outputs.log,
            undefined,
            containerCleanup(cidfile),
          );
        }
        if (result.code === 0 && !result.signal) {
          outputs.commit();
        } else {
          outputs.abort();
        }
      } catch (e) {
        outputs.abort();
        throw e;
      } finally {
        outputs.release();
        rmSync(planDir, { recursive: true, force: true });
        // what this build used from the cache (or put there) counts as used now: `cache prune` keeps it
        touchEntries(
          cacheRoot(),
          plan.libraries.map((l) => l.key),
        );
        touchKeptSources(cacheRoot(), join(out, `${plan.name}.sources.json`));
      }
      // stopped by SIGINT/SIGTERM: the child is gone and the previous outputs are in place; the locks go next
      if (result.signal) {
        throw new Interrupted(result.signal);
      }
      if (result.code !== 0) {
        const what = result.lastError ?? "FFmpeg's build failed";
        throw new BuildFailure(
          [...built, `building ${plan.name} failed: ${what}; the log is ${displayPath(log)}`].join(
            '\n',
          ),
        );
      }
      built.push(
        only
          ? `built ${only.join(', ')} for ${job.platform} (libraries only, no FFmpeg)`
          : `built ${displayPath(join(out, `${plan.name}.tar.gz`))}, ${plan.name}-dev.tar.gz${existsSync(join(out, symbolsName(plan.name))) ? `, ${symbolsName(plan.name)}` : ''} and ${plan.name}.sources.json`,
      );
    }
    return { output: built.join('\n'), exitCode: 0 };
  } finally {
    release();
    registration.release();
  }
}
