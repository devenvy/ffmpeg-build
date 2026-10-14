import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildModules, workerPath } from './modules.ts';
import { onInterrupt } from '../interrupt.ts';

/** execFile as a promise of its output; it rejects with execFile's error (its `code` says ENOENT for a missing command). */
async function execFileAsync(
  file: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const failure: Error = error;
        reject(failure);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** How many hex digits of the Dockerfile's sha256 an image tag carries. */
const TAG_HASH_LENGTH = 12;
/** The default for StreamingOptions.graceMs. */
const STOP_GRACE_MS = 30_000;

/** Errors a cleanup step may meet and can do nothing about. */
const ignore = (): void => undefined;

/** A build that couldn't run or failed; the message says what and where the log is. */
export class BuildError extends Error {}

export function dockerCommand(): string {
  return process.env['FFMPEG_BUILD_DOCKER'] ?? 'docker';
}

/** 'ready', 'missing' (no docker command), or 'stopped' (installed, but its engine doesn't answer). */
export async function dockerStatus(): Promise<'ready' | 'missing' | 'stopped'> {
  try {
    await execFileAsync(dockerCommand(), ['version', '--format', '{{.Server.Version}}'], {
      timeout: 30_000,
    });
    return 'ready';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'stopped';
  }
}

/** The tag for images/<image>/Dockerfile: its name and the first 12 hex of the Dockerfile's sha256. */
export function imageTag(root: string, image: string): string {
  const hash = createHash('sha256')
    .update(readFileSync(join(root, 'images', image, 'Dockerfile')))
    .digest('hex');
  return `ffmpeg-build-${image}:${hash.slice(0, TAG_HASH_LENGTH)}`;
}

async function inspectId(tag: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      dockerCommand(),
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      { timeout: 30_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The docker command that builds a toolchain image. With FFMPEG_BUILD_IMAGE_CACHE=gha (set by the CI workflow), buildx
 * reuses GitHub Actions' cache, one scope per image, so CI doesn't rebuild an unchanged image every run.
 */
export function imageBuildArgs(
  tag: string,
  dir: string,
  image: string,
  cache = process.env['FFMPEG_BUILD_IMAGE_CACHE'],
): string[] {
  if (cache === 'gha') {
    return [
      'buildx',
      'build',
      '--load',
      '--cache-from',
      `type=gha,scope=${image}`,
      '--cache-to',
      `type=gha,mode=max,scope=${image}`,
      '-t',
      tag,
      dir,
    ];
  }
  return ['build', '-t', tag, dir];
}

/**
 * The image's tag and Docker ID, building it from images/<image> when this machine doesn't have it yet. The ID is
 * the library cache's toolchain identity: dnf packages aren't pinned, so a rebuilt image counts as a new toolchain.
 */
export async function ensureImage(
  root: string,
  image: string,
): Promise<{ tag: string; id: string }> {
  const tag = imageTag(root, image);
  let id = await inspectId(tag);
  if (!id) {
    const { code } = await runStreaming(
      dockerCommand(),
      imageBuildArgs(tag, join(root, 'images', image), image),
    );
    if (code !== 0) {
      throw new BuildError(
        `Couldn't build the toolchain image ${tag} (docker build exited ${code}).`,
      );
    }
    id = await inspectId(tag);
    if (!id) {
      throw new BuildError(`Built the toolchain image ${tag}, but Docker can't find it.`);
    }
  }
  return { tag, id };
}

/** --mount, not -v: Windows paths contain ':' and may contain spaces. Its value is CSV, so a path with a comma is quoted. */
export function mountArgs(m: {
  recipes: string;
  engine: string;
  package: string;
  cache: string;
  out: string;
  plan: string;
}): string[] {
  const field = (f: string) => (/[",]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f);
  const mount = (source: string, target: string, readonly: boolean) => [
    '--mount',
    `type=bind,${field(`source=${source}`)},target=${target}${readonly ? ',readonly' : ''}`,
  ];
  return [
    ...mount(m.recipes, '/recipes', true),
    ...mount(m.engine, '/engine', true),
    ...mount(m.package, '/ffmpeg-build', true),
    ...mount(m.cache, '/cache', false),
    ...mount(m.out, '/out', false),
    ...mount(m.plan, '/plan.json', true),
  ];
}

/** The user to hand the build's files back to: the host user on Linux, where a container's root files stay root's. */
export function hostUserOf(platform = process.platform): { uid: number; gid: number } | undefined {
  return platform === 'linux' && process.getuid && process.getgid
    ? { uid: process.getuid(), gid: process.getgid() }
    : undefined;
}

/**
 * The docker run that builds one plan: --init so Ctrl-C reaches the build (a bash pid 1 ignores it). On Linux the
 * driver gives what it wrote back to the host user (Docker Desktop maps ownership itself).
 */
export function dockerRunArgs(m: {
  tag: string;
  recipes: string;
  engine: string;
  package: string;
  cache: string;
  out: string;
  plan: string;
  hostUser?: { uid: number; gid: number };
  cidfile?: string;
}): string[] {
  const { tag, hostUser = hostUserOf(), cidfile, ...mounts } = m;
  // the package is mounted at /ffmpeg-build: its worker as this package has it (TypeScript in a checkout, else dist/)
  const worker = workerPath('/ffmpeg-build', buildModules(m.package), 'posix');
  const owner = hostUser
    ? ['-e', `FFB_HOST_UID=${hostUser.uid}`, '-e', `FFB_HOST_GID=${hostUser.gid}`]
    : [];
  // --cidfile: the container's id, so a stopped build can stop (and remove) its container (containerCleanup)
  return [
    'run',
    '--rm',
    '--init',
    ...(cidfile ? ['--cidfile', cidfile] : []),
    ...owner,
    ...mountArgs(mounts),
    tag,
    'node',
    worker,
  ];
}

export interface StreamingOptions {
  /** How long a signalled child gets to end before it is killed (default 30 s). */
  graceMs?: number;
  /** Called on the first SIGINT/SIGTERM, after it is forwarded to the child (Docker: stop the container). */
  onInterrupt?: (signal: 'SIGINT' | 'SIGTERM') => void | Promise<void>;
  /** Called once the child is gone, before the promise settles (Docker: remove a container its client left). */
  afterExit?: (r: { code: number; signal?: 'SIGINT' | 'SIGTERM' }) => void | Promise<void>;
}

/**
 * Runs a command, showing its output and copying it to `logPath`. Resolves to its exit code and the last
 * `ERROR: ...` line it printed (the driver's way of naming what failed), without the prefix. Inside withInterrupts,
 * a SIGINT/SIGTERM is forwarded to it, a second one or the deadline kills it, and `signal` says which arrived; the
 * promise settles only once the child is gone.
 */
export async function runStreaming(
  command: string,
  args: string[],
  logPath?: string,
  env?: NodeJS.ProcessEnv,
  options: StreamingOptions = {},
): Promise<{ code: number; lastError?: string; signal?: 'SIGINT' | 'SIGTERM' }> {
  return new Promise((resolve, reject) => {
    const log = logPath ? createWriteStream(logPath) : undefined;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let lastError: string | undefined;
    let signal: 'SIGINT' | 'SIGTERM' | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const unsubscribe = onInterrupt((sig, repeated) => {
      signal ??= sig;
      if (repeated) {
        child.kill('SIGKILL');
        return;
      }
      child.kill(sig);
      deadline ??= setTimeout(() => {
        child.kill('SIGKILL');
      }, options.graceMs ?? STOP_GRACE_MS);
      Promise.resolve(options.onInterrupt?.(sig)).catch(ignore);
    });
    const stop = () => {
      unsubscribe();
      if (deadline) {
        clearTimeout(deadline);
      }
    };
    const take = (to: NodeJS.WriteStream) => (d: Buffer) => {
      to.write(d);
      log?.write(d);
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.startsWith('ERROR: ')) {
          lastError = line.slice('ERROR: '.length);
        }
      }
    };
    child.stdout.on('data', take(process.stdout));
    child.stderr.on('data', take(process.stderr));
    child.on('error', (e) => {
      stop();
      reject(e);
    });
    child.on('close', (code) => {
      stop();
      const result = {
        code: code ?? 1,
        ...(lastError ? { lastError } : {}),
        ...(signal ? { signal } : {}),
      };
      const done = () => {
        Promise.resolve()
          .then(async () => options.afterExit?.(result))
          .catch(ignore)
          .then(() => {
            resolve(result);
          }, ignore);
      };
      if (log) {
        log.end(done);
      } else {
        done();
      }
    });
  });
}

/** The container a `docker run --cidfile` started, once Docker has written its id. */
function containerId(cidfile: string): string | undefined {
  try {
    return readFileSync(cidfile, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a build in Docker does when it is stopped: on SIGINT/SIGTERM, `docker stop` its container (the client passes
 * the signal on too, but a client that is itself killed would leave the container running); once the client is gone
 * and the build didn't finish, `docker rm -f` it, in case the client died without taking it down.
 */
export function containerCleanup(
  cidfile: string,
  docker = dockerCommand(),
  exec: (cmd: string, args: string[]) => Promise<unknown> = async (cmd, args) =>
    execFileAsync(cmd, args, { timeout: 60_000 }),
): Pick<StreamingOptions, 'onInterrupt' | 'afterExit'> {
  return {
    onInterrupt: async () => {
      const id = containerId(cidfile);
      if (id) {
        await exec(docker, ['stop', '--time', '10', id]).catch(ignore);
      }
    },
    afterExit: async (r) => {
      const id = containerId(cidfile);
      if (id && (r.code !== 0 || r.signal)) {
        await exec(docker, ['rm', '--force', id]).catch(ignore);
      }
    },
  };
}
