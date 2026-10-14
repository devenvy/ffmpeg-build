// How the CLI reports a failure: the exit code docs/getting-started.md promises (1: a target or build problem; 2: usage, data,
// network or tool), and the text: one line on stderr (or {"error": ..., "problems": [...]} on stdout with --json; a
// command that fails with its own JSON uses the same shape, commands/folder.ts jsonFailure). An error nobody
// anticipated is still one line, with its stack only under FFMPEG_BUILD_DEBUG=1.

import { CliError, EXIT_PROBLEM, EXIT_USAGE } from './cli-error.ts';
import { JSON_INDENT } from './text.ts';

export { CliError, EXIT_PROBLEM, EXIT_USAGE };
export type { ExitCode } from './cli-error.ts';

/** A build that ran and failed (a compiler or recipe step): a build problem, exit 1. */
export class BuildFailure extends CliError {
  constructor(message: string) {
    super(message, EXIT_PROBLEM);
  }
}

/** Errors whose message is written for the user: shown as they are. */
const expected: (abstract new (...args: never[]) => Error)[] = [];

/** Registers error classes the commands throw for the user to read (exit 2 unless they carry an exit code). */
export function expectErrors(...classes: (abstract new (...args: never[]) => Error)[]): void {
  expected.push(...classes);
}

const isExpected = (e: unknown) => e instanceof CliError || expected.some((c) => e instanceof c);

/** The exit code for an error: its own (CliError, FetchError, Interrupted), else 2. */
export function exitCodeFor(e: unknown): number {
  const own = (e as { exitCode?: unknown } | undefined)?.exitCode;
  return typeof own === 'number' ? own : EXIT_USAGE;
}

/** The text for an error: its message (one line for an unexpected one, the stack with `debug`), or JSON. */
export function formatError(e: unknown, options: { json: boolean; debug: boolean }): string {
  const message = e instanceof Error ? e.message : String(e);
  if (options.json) {
    const problems = e instanceof CliError ? e.problems : undefined;
    return JSON.stringify({ error: message, problems: problems ?? [] }, null, JSON_INDENT);
  }
  if (isExpected(e)) {
    return options.debug && e instanceof Error && e.stack ? `${message}\n${e.stack}` : message;
  }
  if (options.debug && e instanceof Error && e.stack) {
    return `ffmpeg-build: ${e.stack}`;
  }
  return `ffmpeg-build: ${message.split('\n')[0] ?? ''} (FFMPEG_BUILD_DEBUG=1 shows where)`;
}
