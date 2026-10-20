// What a target's test scripts may receive besides FFMPEG, FFPROBE and FFMPEG_DIR: the variables its `test-env:` names
// (a key a smoke test decrypts with, an account to upload to), from the build workflow's `test-env` secret or, when that
// doesn't name one, the environment `ffmpeg-build test` runs in. The secret arrives as one variable of NAME=value lines,
// which `test` takes out of its own environment before it starts anything, so nothing it runs sees the whole set; each
// target's scripts get only the names that target lists, in a container too (`docker run -e NAME`, the value in docker's
// environment, never on its command line). On GitHub Actions every value is masked in the log first.
import { CliError } from '../cli-error.ts';

/** The variable build.yml's test steps set from its `test-env` secret: NAME=value lines. */
export const TEST_ENV_VARIABLE = 'FFMPEG_BUILD_TEST_ENV';

/** A name a test script can read: letters, digits and _, not starting with a digit. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `test` sets for every script itself (and the secret's own variable): `test-env:` can't name them. */
export const RESERVED_TEST_ENV: readonly string[] = [
  'FFMPEG',
  'FFPROBE',
  'FFMPEG_DIR',
  'FFMPEG_TARGET',
  'FFMPEG_PLATFORM',
  TEST_ENV_VARIABLE,
];

/** A `test-env` secret that isn't NAME=value lines: a usage problem, shown without the line. */
class TestEnvError extends CliError {}

/**
 * The NAME=value lines of the `test-env` secret: blank lines and # comments skipped, the value everything after the
 * first `=` as written. A line that isn't one is refused by its number alone: the line may hold a secret.
 */
export function parseTestEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      return;
    }
    const where = `${TEST_ENV_VARIABLE} (build.yml's test-env secret), line ${i + 1}`;
    const eq = line.indexOf('=');
    const name = eq < 0 ? '' : line.slice(0, eq).trim();
    if (!ENV_NAME.test(name)) {
      throw new TestEnvError(
        `${where}: expected NAME=value with a name of letters, digits and _ (the line isn't shown: it may hold a secret)`,
      );
    }
    if (RESERVED_TEST_ENV.includes(name)) {
      throw new TestEnvError(`${where}: ${name} is set by ffmpeg-build test itself`);
    }
    if (values.has(name)) {
      throw new TestEnvError(`${where}: ${name} is given twice`);
    }
    const value = line.slice(eq + 1);
    if (value.includes('\0')) {
      throw new TestEnvError(`${where}: ${name}'s value has a NUL character`);
    }
    values.set(name, value);
  });
  return values;
}

/** The workflow command that hides a value in a GitHub Actions log, escaped as the Actions toolkit escapes it. */
export const maskCommand = (value: string): string =>
  `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`;

/** Whether this runs in GitHub Actions, where `print`ed workflow commands reach the runner. */
const onGitHubActions = (env: NodeJS.ProcessEnv): boolean => env['GITHUB_ACTIONS'] === 'true';

/**
 * Takes the `test-env` secret out of `env` (the process's own, so nothing started afterwards inherits it) and returns
 * its values, each masked first on GitHub Actions.
 */
export function takeTestEnv(
  env: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Map<string, string> {
  const text = env[TEST_ENV_VARIABLE];
  Reflect.deleteProperty(env, TEST_ENV_VARIABLE);
  if (!text) {
    return new Map();
  }
  const values = parseTestEnv(text);
  if (onGitHubActions(env)) {
    for (const v of values.values()) {
      if (v) {
        print(maskCommand(v));
      }
    }
  }
  return values;
}

/**
 * The variables one target's scripts get: each name its `test-env:` lists, from the secret when it names it (empty
 * there means not given: a secret a run doesn't have, as in a pull request from a fork, is empty), else from `env`.
 * `missing` are the names with no value. A value taken from `env` is masked too, on GitHub Actions.
 */
export function targetTestEnv(
  names: readonly string[],
  secret: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  print: (line: string) => void,
): { vars: Record<string, string>; missing: string[] } {
  const vars: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const fromEnv = !secret.has(n);
    const v = fromEnv ? env[n] : secret.get(n);
    if (!v) {
      missing.push(n);
    } else {
      if (fromEnv && onGitHubActions(env)) {
        print(maskCommand(v));
      }
      vars[n] = v;
    }
  }
  return { vars, missing };
}

/**
 * `env` for a native test script: without the variables the secret names (another target's, or one this target
 * doesn't list), then this target's. Windows' variable names are any case, so there a name is removed in every case.
 */
export function scriptEnv(
  env: NodeJS.ProcessEnv,
  secret: ReadonlyMap<string, string>,
  vars: Record<string, string>,
  host: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const fold = (k: string) => (host === 'win32' ? k.toUpperCase() : k);
  const drop = new Set([...secret.keys(), ...Object.keys(vars)].map(fold));
  return {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(fold(k)))),
    ...vars,
  };
}
