/** Exit 1: a target has problems, or a build ran and failed. */
export const EXIT_PROBLEM = 1;
/** Exit 2: usage, data, network or tool. */
export const EXIT_USAGE = 2;
/** The exit codes a failure can have. */
export type ExitCode = typeof EXIT_PROBLEM | typeof EXIT_USAGE;

/** A failure with its exit code, for a command to throw instead of returning an error as a result. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly problems: string[] | undefined;
  constructor(message: string, exitCode: ExitCode = EXIT_USAGE, problems?: string[]) {
    super(message);
    this.exitCode = exitCode;
    this.problems = problems;
  }
}
