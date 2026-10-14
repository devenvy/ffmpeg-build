import { type ChildProcess, spawn } from 'node:child_process';

export class StepError extends Error {}

export function step(message: string): void {
  process.stdout.write(`\n==> ${message}\n`);
}

function commandArgs(command: string, args: readonly string[]): string[] {
  if (process.platform !== 'win32' || !['tar', 'gzip'].includes(command)) {
    return [...args];
  }
  return args.map((arg) =>
    arg.replace(
      /^([A-Za-z]):[\\/](.*)$/,
      (_, drive: string, rest: string) => `/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`,
    ),
  );
}

const SCRIPTS = new Set([
  'autoreconf',
  'autoconf',
  'automake',
  'aclocal',
  'autoheader',
  'autopoint',
  'libtoolize',
  'sh',
]);
/** A command Windows can't start without a shell: a path to a script (./configure, ./autogen.sh) or an autotool. */
export function isScript(command: string): boolean {
  return (
    SCRIPTS.has(command) ||
    command.startsWith('./') ||
    command.endsWith('.sh') ||
    /(?:^|[\\/])configure$/.test(command)
  );
}

// The commands running now, so a stopped worker can pass its signal on (stopChildren); once stopping, nothing new starts.
const active = new Set<ChildProcess>();
let stopping: NodeJS.Signals | undefined;

/** Whether the worker is stopping (a SIGINT/SIGTERM arrived). */
export const isStopping = (): boolean => stopping !== undefined;

/**
 * The worker was told to stop: passes `signal` to every running command, kills what is left after `graceMs`, and
 * resolves once they are all gone. Commands started afterwards fail at once.
 */
export async function stopChildren(signal: NodeJS.Signals, graceMs = 20_000): Promise<void> {
  stopping ??= signal;
  const children = [...active];
  for (const child of children) {
    child.kill(signal);
  }
  const gone = children.map(
    async (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
        } else {
          child.once('close', () => resolve());
        }
      }),
  );
  const deadline = setTimeout(() => {
    for (const child of children) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  return Promise.all(gone).then(() => clearTimeout(deadline));
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  input?: string | Buffer;
  /** Kill the command (SIGTERM, then SIGKILL 10 s later) when it runs longer than this. */
  timeoutMs?: number;
  /** Runs even while the worker is stopping (handing the files back to the host user). */
  evenWhenStopping?: boolean;
  /** With capture: the most stdout kept (default 64 MB); a command printing more fails. */
  maxCapture?: number;
  /** With capture: stdout goes here as it comes, and isn't kept (searchOutput). */
  onStdout?: (chunk: Buffer) => void;
}

const KIB = 1024;
const MIB = KIB * KIB;
const MAX_CAPTURE_MIB = 64;
const MAX_CAPTURE = MAX_CAPTURE_MIB * MIB;
/** How much of a failing command's stderr its error message keeps: the end, where the error usually is. */
const STDERR_TAIL_KIB = 8;
const STDERR_TAIL = STDERR_TAIL_KIB * KIB;
/** stderr is cut back to its tail once it holds this many times the tail, not on every chunk. */
const STDERR_SLACK = 2;
/** How long a command that timed out gets after SIGTERM before SIGKILL. */
const KILL_AFTER_MS = 10_000;
const MS_PER_SECOND = 1_000;
/** retry: each wait is up to this fraction shorter, at random. */
const RETRY_JITTER = 0.25;
/** retry: each wait is this many times the one before. */
const RETRY_BACKOFF = 2;

const NEWLINE = 0x0a;
/** How much of a found string's line a message quotes. */
const LINE_MAX = 300;

/**
 * Which of `needles` a command's output contains, and on what line, searched as it streams (a big binary's
 * `strings -a` isn't kept): each chunk is searched together with the end of the one before, so a needle split across
 * two is still found.
 */
export async function searchOutput(
  command: string,
  args: readonly string[],
  needles: readonly string[],
  options: Omit<RunOptions, 'capture' | 'onStdout'> = {},
): Promise<{ needle: string; line: string }[]> {
  const wanted = needles.filter(Boolean);
  const found = new Map<string, string>();
  const keep = Math.max(0, ...wanted.map((n) => Buffer.byteLength(n))) - 1;
  let carry = Buffer.alloc(0);
  // the line a needle sits on, as far as this window has it (enough to name the string)
  const lineAt = (window: Buffer, at: number): string => {
    const start = window.lastIndexOf(NEWLINE, at) + 1;
    const end = window.indexOf(NEWLINE, at);
    return window
      .subarray(start, end === -1 ? window.length : end)
      .toString('utf8')
      .slice(0, LINE_MAX)
      .trim();
  };
  await run(command, args, {
    ...options,
    capture: true,
    onStdout: (chunk) => {
      const window = Buffer.concat([carry, chunk]);
      for (const n of wanted) {
        const at = found.has(n) ? -1 : window.indexOf(n);
        if (at !== -1) {
          found.set(n, lineAt(window, at));
        }
      }
      carry = keep > 0 ? window.subarray(Math.max(0, window.length - keep)) : Buffer.alloc(0);
    },
  });
  return wanted.flatMap((n) => {
    const line = found.get(n);
    return line === undefined ? [] : [{ needle: n, line }];
  });
}

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (stopping && !options.evenWhenStopping) {
      reject(new StepError(`not running ${command}: the build is stopping (${stopping})`));
      return;
    }
    const translated = commandArgs(command, args);
    // Windows can't start a shell script itself: configure scripts, autogen.sh, and the autotools (scripts in MSYS2)
    const throughBash =
      process.platform === 'win32' &&
      (['curl', 'gzip', 'make', 'tar'].includes(command) || isScript(command));
    const child = spawn(
      throughBash ? 'bash' : command,
      throughBash ? ['-c', 'exec "$@"', '_', command, ...translated] : translated,
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          options.capture ? 'pipe' : 'inherit',
          options.capture ? 'pipe' : 'inherit',
        ],
      },
    );
    active.add(child);
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            kill = setTimeout(() => {
              child.kill('SIGKILL');
            }, KILL_AFTER_MS);
          }, options.timeoutMs);
    // stdout is kept up to maxCapture (or passed to onStdout and not kept); of stderr only the tail, for the message
    const max = options.maxCapture ?? MAX_CAPTURE;
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let tooMuch = false;
    let stderr = Buffer.alloc(0);
    child.stdout?.on('data', (data: Buffer) => {
      if (options.onStdout) {
        options.onStdout(data);
        return;
      }
      if (tooMuch) {
        return;
      }
      stdoutSize += data.length;
      if (stdoutSize > max) {
        tooMuch = true;
        stdout.length = 0;
        child.kill('SIGTERM');
        return;
      }
      stdout.push(data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = Buffer.concat([stderr, data]);
      if (stderr.length > STDERR_TAIL * STDERR_SLACK) {
        stderr = stderr.subarray(stderr.length - STDERR_TAIL);
      }
    });
    const done = () => {
      active.delete(child);
      if (timer) {
        clearTimeout(timer);
      }
      if (kill) {
        clearTimeout(kill);
      }
    };
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code, signal) => {
      done();
      const tail = () => {
        const text =
          stderr.length > STDERR_TAIL
            ? `...${stderr.subarray(stderr.length - STDERR_TAIL).toString()}`
            : stderr.toString();
        return text.trim() ? `: ${text.trim()}` : '';
      };
      if (tooMuch) {
        reject(
          new StepError(
            `${command} printed more than ${max / MIB} MB, more than ffmpeg-build keeps of a command's output`,
          ),
        );
      } else if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
      } else if (timedOut) {
        reject(new StepError(`${command} timed out after ${options.timeoutMs! / MS_PER_SECOND} s`));
      } else {
        reject(
          new StepError(
            `${command} ${code === null ? `was stopped (${String(signal)})` : `exited ${code}`}${tail()}`,
          ),
        );
      }
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Runs `action` up to `attempts` times, waiting 4 s, 8 s, 16 s... (each less up to a quarter, at random, so builds
 * that failed together don't retry together). `shouldRetry` says which failures are worth another attempt.
 */
export async function retry<T>(
  attempts: number,
  action: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let delay = 4_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || stopping || !shouldRetry(error)) {
        throw error;
      }
      const wait = Math.round(delay * (1 - RETRY_JITTER + Math.random() * RETRY_JITTER));
      process.stderr.write(
        `  failed (attempt ${attempt}/${attempts}) -- retrying in ${(wait / MS_PER_SECOND).toFixed(1)}s\n`,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
      delay *= RETRY_BACKOFF;
    }
  }
}
