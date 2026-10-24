import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  changedFiles,
  copyLicenses,
  FFB_SHARE,
  listing,
  restoreCache,
  saveCache,
  writeSourceRecord,
} from './cache.ts';
import { type CrateInventory, crateLicenseProblems, discoverCrates, keepCrates } from './cargo.ts';
import { fetchSource, keepGitSource, sourceRecord, type SourceRecord } from './fetch.ts';
import {
  editPcField,
  editPcVariables,
  expandArgs,
  expandText,
  globPaths,
  type Lookup,
  pkgConfigText,
  type Value,
  versionAtLeast,
} from './recipe-ops.ts';
import { run, step } from './run.ts';
import { keepSupplementalSources } from './supplemental-sources.ts';
import { platformMatches } from '../platforms.ts';
import { cxxRuntime, type Toolchain } from './toolchain.ts';
import { PC_FIELDS, type Recipe } from '../schema/engine.ts';

import type { BuildPlan } from './plan.ts';

export interface BuildPaths {
  plan: string;
  recipes: string;
  engine: string;
  cache: string;
  out: string;
  depsDir: string;
  work: string;
}

export interface BuildContext extends BuildPaths {
  buildPlan: BuildPlan;
  sources: string;
  jobs: number;
  env: NodeJS.ProcessEnv;
  toolchain: Toolchain;
}

type PlannedLibrary = BuildPlan['libraries'][number];

/** An environment value that starts with this appends to the variable instead of replacing it. */
const APPEND = '+=';
/** How much of a step this engine doesn't know its error shows. */
const UNKNOWN_STEP_PREVIEW = 200;
/** How many times shaderc's git-sync-deps runs when GIT_CLONE_ATTEMPTS doesn't say. */
const DEFAULT_CLONE_ATTEMPTS = 6;
/** The wait before the nth retry of git-sync-deps is n times this. */
const SYNC_RETRY_DELAY_MS = 4_000;

type BuildStep = Recipe['build']['steps'][number];
type Env = Recipe['build']['env'];
type BuildAddition = Recipe['build']['platforms'][string];
type DefaultedAddition = 'env' | 'unset' | 'vars' | 'before' | 'after';
type DefaultedBuild =
  'unset' | 'vars' | 'before' | 'configure-script' | 'make-targets' | 'install-targets';
/**
 * A library's build as the worker reads it from the plan: a plan written by hand (the tests' fake builds) or by an
 * older engine may leave out what the recipe schema fills in with its defaults.
 */
type PlannedBuild = Omit<Recipe['build'], DefaultedBuild | 'platforms'> &
  Partial<Pick<Recipe['build'], DefaultedBuild>> & {
    platforms: Record<
      string,
      Omit<BuildAddition, DefaultedAddition> & Partial<Pick<BuildAddition, DefaultedAddition>>
    >;
  };
type When =
  | {
      platforms?: string[] | undefined;
      exists?: string | undefined;
      missing?: string | undefined;
      set?: string | undefined;
      unset?: string | undefined;
    }
  | undefined;

/** What one recipe's build sees while it runs: its folders, the platform's toolchain, and its variables. */
class RecipeScope {
  readonly vars = new Map<string, Value>();
  readonly lookup: Lookup = (name) =>
    this.vars.get(name) ?? this.builtin(name) ?? this.context.env[name];
  readonly context: BuildContext;
  readonly src: string;
  readonly version: string;
  readonly args: readonly string[];
  /** The recipe's name, for messages ('' when the caller doesn't say). */
  readonly name: string;
  constructor(
    context: BuildContext,
    src: string,
    version: string,
    args: readonly string[],
    name = '',
  ) {
    this.context = context;
    this.src = src;
    this.version = version;
    this.args = args;
    this.name = name;
  }

  private builtin(name: string): Value | undefined {
    const { context } = this;
    switch (name) {
      case 'deps':
      case 'prefix':
        return context.depsDir;
      case 'jobs':
        return String(context.jobs);
      case 'host':
        return context.env['CROSS_HOST'] ?? '';
      case 'src':
        return this.src;
      case 'version':
        return this.version;
      case 'platform':
        return context.buildPlan.platform;
      case 'cxx-runtime':
        return cxxRuntime(context.buildPlan.platform);
      case 'args':
        return expandArgs(this.args, this.lookup);
      case 'cmake-cross-args':
        return context.toolchain.cmakeArgs;
      case 'meson-cross-args':
        return context.toolchain.mesonArgs;
      default:
        return undefined;
    }
  }

  text(value: string): string {
    return expandText(value, this.lookup).text;
  }
  argv(values: readonly string[]): string[] {
    return expandArgs(values, this.lookup);
  }
  setVars(values: Record<string, Value>): void {
    for (const [name, value] of Object.entries(values)) {
      this.vars.set(name, Array.isArray(value) ? this.argv(value) : this.text(value));
    }
  }

  /** A path for a file operation, inside the source or dependency folder. */
  path(raw: string): string {
    const path = this.text(raw);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.src, path);
    const roots = [resolve(this.src), resolve(this.context.depsDir)];
    if (
      !roots.some(
        (root) =>
          absolute === root || absolute.startsWith(`${root}\\`) || absolute.startsWith(`${root}/`),
      )
    ) {
      throw new Error(`file operation path is outside the source and dependency folders: ${raw}`);
    }
    return absolute;
  }

  /** The environment with a recipe's or step's additions: `+=` appends, an empty `{name?}` leaves it alone; `unset` removes. */
  environment(
    base: NodeJS.ProcessEnv,
    values: Env,
    unset: readonly string[] = [],
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(base).filter(([name]) => !unset.includes(name)),
    );
    for (const [name, raw] of Object.entries(values)) {
      const { text, dropped } = expandText(raw, this.lookup);
      if (!dropped) {
        env[name] = text.startsWith(APPEND)
          ? `${env[name] ?? ''}${text.slice(APPEND.length)}`
          : text;
      }
    }
    return env;
  }

  holds(when: When): boolean {
    if (!when) {
      return true;
    }
    if (when.platforms && !platformMatches(this.context.buildPlan.platform, when.platforms)) {
      return false;
    }
    if (when.exists !== undefined && !globPaths(this.path(when.exists)).length) {
      return false;
    }
    if (when.missing !== undefined && globPaths(this.path(when.missing)).length) {
      return false;
    }
    if (when.set !== undefined && !this.text(when.set)) {
      return false;
    }
    if (when.unset !== undefined && this.text(when.unset)) {
      return false;
    }
    return true;
  }
}

function additions(
  build: PlannedBuild,
  platform: string,
): {
  args: string[];
  env: Env;
  unset: string[];
  vars: Record<string, Value>[];
  before: BuildStep[];
  after: BuildStep[];
} {
  const matched = Object.entries(build.platforms)
    .filter(([pattern]) => platformMatches(platform, [pattern]))
    .map(([, value]) => value);
  return {
    args: matched.flatMap((value) => value.args),
    env: Object.fromEntries(matched.flatMap((value) => Object.entries(value.env ?? {}))),
    unset: matched.flatMap((value) => value.unset ?? []),
    vars: matched.map((value) => value.vars ?? {}),
    before: matched.flatMap((value) => value.before ?? []),
    after: matched.flatMap((value) => value.after ?? []),
  };
}

const BOOTSTRAP: Record<string, string[]> = {
  autogen: ['./autogen.sh'],
  autoreconf: ['autoreconf', '-fi'],
};

/** `bootstrap:` before everything else; with several, each but the last is tried quietly and the first that works wins. */
async function bootstrap(
  scripts: readonly string[],
  src: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const [index, script] of scripts.entries()) {
    const [command, ...args] = BOOTSTRAP[script] ?? [`./${script}`];
    const last = index === scripts.length - 1;
    try {
      await run(command!, args, { cwd: src, env, ...(last ? {} : { capture: true }) });
      return;
    } catch (error) {
      if (last) {
        throw error;
      }
    }
  }
}

/** Whether `path` is a file this process may run (on Windows, any file). */
function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    /* not this one */
    return false;
  }
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const extensions =
    process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    if (extensions.some((extension) => isRunnable(join(dir, `${command}${extension}`)))) {
      return true;
    }
  }
  return false;
}

type Check = Extract<BuildStep, { check: unknown }>['check'];

async function runCheck(check: Check, scope: RecipeScope, env: NodeJS.ProcessEnv): Promise<void> {
  const fail: (detail?: string) => never = (detail = '') => {
    throw new Error(`${scope.text(check.message)}${detail}`);
  };
  if (check.exists !== undefined) {
    if (!globPaths(scope.path(check.exists)).length) {
      fail();
    }
  } else if (check.missing !== undefined) {
    const [first] = globPaths(scope.path(check.missing));
    if (first !== undefined) {
      fail(` (${first})`);
    }
  } else if (check.file !== undefined) {
    const file = globPaths(scope.path(check.file))[0];
    if (!file) {
      fail(` (no ${check.file})`);
    }
    const text = readFileSync(file, 'latin1');
    if (check.contains !== undefined) {
      const wanted = scope.text(check.contains);
      if (
        !(check['ignore-case']
          ? text.toLowerCase().includes(wanted.toLowerCase())
          : text.includes(wanted))
      ) {
        fail();
      }
    } else if (!text.split(/\r?\n/).includes(scope.text(check.line!))) {
      fail();
    }
  } else if (check.command !== undefined) {
    if (!onPath(scope.text(check.command), env)) {
      fail();
    }
  } else {
    const [command, ...args] = scope.argv(check.output!);
    let output = '';
    try {
      output = await run(command!, args, {
        cwd: resolve(scope.src, check.cwd ?? '.'),
        env,
        capture: true,
      });
    } catch {
      /* no output: no match */
    }
    const match = new RegExp(scope.text(check.matches!), check['ignore-case'] ? 'mi' : 'm').exec(
      output,
    );
    if (!match) {
      fail();
    }
    if (check['min-version'] && !versionAtLeast(match[1] ?? match[0], check['min-version'])) {
      fail(` (found ${match[1] ?? match[0]})`);
    }
  }
}

async function runStep(item: BuildStep, scope: RecipeScope, env: NodeJS.ProcessEnv): Promise<void> {
  const { src } = scope;
  if (Array.isArray(item)) {
    const [command, ...args] = scope.argv(item);
    await run(command!, args, { cwd: src, env });
    return;
  }
  if ('when' in item && !scope.holds(item.when)) {
    return;
  }
  if ('run' in item) {
    const [command, ...args] = scope.argv(item.run);
    await run(command!, args, {
      cwd: resolve(src, item.cwd ?? '.'),
      env: scope.environment(env, item.env, item.unset),
    });
  } else if ('replace-in-file' in item) {
    const operation = item['replace-in-file'];
    const path = scope.path(operation.path);
    if (operation.optional && !existsSync(path)) {
      return;
    }
    const from = scope.text(operation.from);
    const to = scope.text(operation.to);
    const text = readFileSync(path, 'utf8');
    const pattern = operation.regex ? new RegExp(from, 'gm') : undefined;
    // an edit that changes nothing is a recipe out of step with its source (upstream moved the text): it fails,
    // unless the recipe says the edit is optional
    if (!(pattern ? pattern.test(text) : text.includes(from))) {
      if (operation.optional) {
        return;
      }
      throw new Error(
        `${scope.name ? `${scope.name}: ` : ''}replace-in-file found nothing to replace in ${operation.path}: ${
          pattern ? `the pattern ${from} doesn't match it` : `${from} isn't in it`
        } (the source changed? update the recipe's edit, or make it optional: true if it may find nothing)`,
      );
    }
    // (a global regex's replace starts from the beginning whatever test() left in lastIndex)
    writeFileSync(path, pattern ? text.replace(pattern, to) : text.replaceAll(from, to));
  } else if ('copy' in item) {
    const operation = item.copy;
    const sources = operation.from.flatMap((from) => {
      const path = scope.path(from);
      const found = globPaths(path);
      if (!found.length) {
        throw new Error(`copy: nothing at ${from}`);
      }
      return found;
    });
    const options = {
      recursive: operation.recursive,
      preserveTimestamps: operation.preserve,
      verbatimSymlinks: true,
    };
    if (operation.to !== undefined) {
      const to = scope.path(operation.to);
      if (sources.length !== 1) {
        throw new Error(
          `copy: ${operation.from.join(' ')} is ${sources.length} files; copy them into: a folder`,
        );
      }
      mkdirSync(dirname(to), { recursive: true });
      cpSync(sources[0]!, to, options);
    } else {
      const into = scope.path(operation.into!);
      mkdirSync(into, { recursive: true });
      for (const from of sources) {
        cpSync(from, join(into, basename(from)), options);
      }
    }
  } else if ('move' in item) {
    const to = scope.path(item.move.to);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(scope.path(item.move.from), to);
  } else if ('write-file' in item) {
    const operation = item['write-file'];
    const path = scope.path(operation.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, scope.text(operation.text));
  } else if ('remove' in item) {
    const operation = item.remove;
    const path = scope.path(operation.path);
    for (const found of /[*?]/.test(path) ? globPaths(path) : [path]) {
      rmSync(found, { recursive: operation.recursive, force: true });
    }
  } else if ('pkg-config' in item) {
    const pc = item['pkg-config'];
    const text = (value: string | undefined) =>
      value === undefined ? undefined : scope.text(value);
    const path = join(scope.context.depsDir, 'lib', 'pkgconfig', `${pc.file ?? pc.name}.pc`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      pkgConfigText(scope.context.depsDir, {
        name: scope.text(pc.name),
        description: scope.text(pc.description),
        version: scope.text(pc.version),
        requires: text(pc.requires),
        libs: text(pc.libs),
        libsPrivate: text(pc['libs-private']),
        cflags: text(pc.cflags),
        execPrefix: pc['exec-prefix'],
      }),
    );
  } else if ('edit-pkg-config' in item) {
    const operation = item['edit-pkg-config'];
    const paths = globPaths(scope.path(operation.path));
    if (!paths.length && !operation.optional) {
      throw new Error(`edit-pkg-config: there is no ${operation.path}`);
    }
    const value = (v: string | undefined): string | undefined =>
      v === undefined ? undefined : scope.text(v);
    for (const path of paths) {
      let text = editPcVariables(
        readFileSync(path, 'utf8'),
        Object.fromEntries(
          Object.entries(operation.variables ?? {}).map(([name, raw]) => [name, value(raw)]),
        ),
      );
      for (const field of Object.keys(PC_FIELDS) as (keyof typeof PC_FIELDS)[]) {
        const edit = operation[field];
        if (edit) {
          text = editPcField(text, field, {
            append: value(edit.append),
            prepend: value(edit.prepend),
            add: value(edit.add),
            set: value(edit.set),
            remove: value(edit.remove),
            tokens: edit.tokens,
            removeLibraryPaths: edit['remove-library-paths'],
            missing: edit.missing,
          });
        }
      }
      writeFileSync(path, text);
    }
  } else if ('vars' in item) {
    scope.setVars(item.vars);
  } else if ('find' in item) {
    const operation = item.find;
    let found = '';
    for (const pattern of operation.glob) {
      // the path as the pattern writes it ({deps}/lib/x.a, not a normalized one); a relative
      // pattern gives a path relative to the source, as `find _build ...` printed it
      const written = scope.text(pattern);
      const absolute = scope.path(pattern);
      found =
        globPaths(isAbsolute(written) ? written : absolute, operation['ignore-case'])[0] ?? '';
      if (found && !isAbsolute(written)) {
        found = relative(src, found).replaceAll('\\', '/');
      }
      if (found) {
        break;
      }
    }
    if (!found && operation.required) {
      throw new Error(scope.text(operation.required));
    }
    let value = found;
    if (operation.dirname) {
      value = found ? dirname(found) : '.';
    } else if (operation.basename) {
      value = basename(found);
    }
    scope.vars.set(operation.var, value);
  } else if ('read' in item) {
    const operation = item.read;
    const matches = [
      ...readFileSync(scope.path(operation.file), 'utf8').matchAll(
        new RegExp(operation.pattern, 'gm'),
      ),
    ];
    const match = operation.last ? matches.at(-1) : matches[0];
    if (!match) {
      throw new Error(scope.text(operation.message));
    }
    scope.vars.set(operation.var, match[1] ?? match[0]);
  } else if ('check' in item) {
    await runCheck(item.check, scope, env);
  } else if ('sync-shaderc-deps' in item) {
    await syncShadercDeps(src, env);
  } else {
    // a plan written by an older engine (a shell: step) or by hand
    throw new Error(
      `a build step this engine doesn't know: ${JSON.stringify(item).slice(0, UNKNOWN_STEP_PREVIEW)}`,
    );
  }
}

async function syncShadercDeps(src: string, env: NodeJS.ProcessEnv): Promise<void> {
  let python = '';
  for (const candidate of ['python3', 'python']) {
    try {
      await run(candidate, ['-c', 'import sys'], { cwd: src, env, capture: true });
      python = candidate;
      break;
    } catch {
      /* try the next executable */
    }
  }
  if (!python) {
    throw new Error(
      "no working python3/python on PATH (a name that resolves but fails to run doesn't count)",
    );
  }
  const verify = [
    'import os, subprocess',
    'g = {}',
    'exec(compile(open("DEPS").read(), "DEPS", "exec"), {"Var": lambda k: g["vars"][k]}, g)',
    'for rel, spec in sorted(g.get("deps", {}).items()):',
    ' rev = spec.partition("@")[2]',
    ' r = subprocess.run(["git", "-C", rel, "rev-parse", "HEAD"], capture_output=True, text=True) if os.path.exists(os.path.join(rel, ".git")) else None',
    ' if not r or r.returncode or r.stdout.strip() != rev: print(rel)',
  ].join('\n');
  const attempts = Number(env['GIT_CLONE_ATTEMPTS'] ?? DEFAULT_CLONE_ATTEMPTS);
  for (let n = 1; n <= attempts; n++) {
    try {
      await run(python, ['./utils/git-sync-deps'], {
        cwd: src,
        env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      /* its worker failures do not reliably set the exit status */
    }
    let bad: string[];
    try {
      bad = (await run(python, ['-c', verify], { cwd: src, env, capture: true }))
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      bad = ['DEPS-unreadable'];
    }
    if (!bad.length) {
      process.stdout.write('shaderc third_party sources verified at their pinned revisions.\n');
      return;
    }
    if (n === attempts) {
      throw new Error(`shaderc third_party not synced after ${n} attempts: ${bad.join(' ')}`);
    }
    for (const dep of bad) {
      if (dep !== 'DEPS-unreadable') {
        const path = resolve(src, dep);
        if (path !== src && (path.startsWith(`${src}/`) || path.startsWith(`${src}\\`))) {
          rmSync(path, { recursive: true, force: true });
        }
      }
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, SYNC_RETRY_DELAY_MS * n);
    });
  }
}

/**
 * A Rust library's crates (build.cargo), once its before: steps have set up Rust: listed, checked against
 * licenses.yml before anything is compiled, and the build told to stay offline from then on.
 */
async function rustCrates(
  context: BuildContext,
  library: { name?: string | undefined; license?: string | undefined; build: PlannedBuild },
  scope: RecipeScope,
  env: NodeJS.ProcessEnv,
): Promise<CrateInventory | undefined> {
  const cargo = library.build.cargo;
  if (!cargo) {
    return undefined;
  }
  const name = library.name ?? 'the library';
  const plan = context.buildPlan;
  if (!plan.cargo || library.license === undefined) {
    throw new Error(
      `${name} builds with cargo, but the build plan has no licence table for its crates (made by an older engine?)`,
    );
  }
  const table = new Map(Object.entries(plan.cargo.licenses));
  const inventory = await discoverCrates({
    library: name,
    src: scope.src,
    env,
    target: scope.text(cargo.target),
    package: scope.text(cargo.package),
    features: scope.argv(cargo.features),
    standardTexts: cargo['standard-texts'],
    textIds: Object.keys(plan.cargo.texts),
    table,
  });
  const problems = crateLicenseProblems({
    library: name,
    recipeLicense: library.license,
    buildLicense: plan.license,
    table,
    crates: [inventory.root, ...inventory.crates.filter((c) => c.linked)],
  });
  if (problems.length) {
    throw new Error(`${name}'s Rust crates fail the licence check: ${problems.join('; ')}`);
  }
  // what was just listed is all the build may use: nothing more is fetched
  Object.assign(env, { CARGO_NET_OFFLINE: 'true' });
  return inventory;
}

export async function runRecipe(
  context: BuildContext,
  library: {
    name?: string;
    version: string;
    license?: string;
    build: PlannedBuild;
  },
  src: string,
): Promise<{ crates?: CrateInventory }> {
  const build = library.build;
  const extra = additions(build, context.buildPlan.platform);
  const scope = new RecipeScope(
    context,
    src,
    library.version,
    [...build.args, ...extra.args],
    library.name,
  );
  scope.setVars(build.vars ?? {});
  for (const values of extra.vars) {
    scope.setVars(values);
  }
  const env = scope.environment(context.env, { ...build.env, ...extra.env }, [
    ...(build.unset ?? []),
    ...extra.unset,
  ]);
  Object.assign(env, {
    RECIPES: context.recipes,
    ENGINE: context.engine,
    SETUP: context.buildPlan.setup,
    SRC_DIR: src,
    VERSION: library.version,
    DEPS_DIR: context.depsDir,
    BUILD_RID: context.buildPlan.platform,
    JOBS: String(context.jobs),
    PKG_CONFIG_PATH: join(context.depsDir, 'lib', 'pkgconfig'),
  });
  if (build.bootstrap) {
    await bootstrap(build.bootstrap, src, env);
  }
  for (const item of [...(build.before ?? []), ...extra.before]) {
    await runStep(item, scope, env);
  }
  const crates = await rustCrates(context, library, scope, env);
  // after the before-steps, which may set the variables the arguments use
  const args = () => scope.argv([...build.args, ...extra.args]);
  if (build.steps.length) {
    for (const item of build.steps) {
      await runStep(item, scope, env);
    }
  } else if (build.system === 'cmake') {
    const source = build['source-dir'] ?? '.';
    await run(
      'cmake',
      [
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-B',
        '_build',
        '-S',
        source,
        '-DCMAKE_BUILD_TYPE=Release',
        `-DCMAKE_INSTALL_PREFIX=${context.depsDir}`,
        '-DCMAKE_INSTALL_LIBDIR=lib',
        `-DCMAKE_PREFIX_PATH=${context.depsDir}`,
        '-DBUILD_SHARED_LIBS=OFF',
        '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
        ...context.toolchain.cmakeArgs,
        ...args(),
      ],
      { cwd: src, env },
    );
    const targets = scope.argv(build['build-targets'] ?? []);
    await run(
      'cmake',
      [
        '--build',
        '_build',
        `-j${context.jobs}`,
        ...(targets.length ? ['--target', ...targets] : []),
      ],
      { cwd: src, env },
    );
    for (const component of scope.argv(build['install-components'] ?? [''])) {
      await run(
        'cmake',
        ['--install', '_build', ...(component ? ['--component', component] : [])],
        {
          cwd: src,
          env,
        },
      );
    }
  } else if (build.system === 'meson') {
    const source = build['source-dir'] ?? '.';
    await run(
      'meson',
      [
        'setup',
        '_build',
        source,
        `--prefix=${context.depsDir}`,
        '--libdir=lib',
        '--default-library=static',
        '--buildtype=release',
        ...context.toolchain.mesonArgs,
        ...args(),
      ],
      { cwd: src, env },
    );
    await run('meson', ['compile', '-C', '_build', '-j', String(context.jobs)], { cwd: src, env });
    await run('meson', ['install', '-C', '_build'], { cwd: src, env });
  } else if (build.system === 'autotools') {
    const buildSrc = resolve(src, build['source-dir'] ?? '.');
    // what every old build.sh had in common: the prefix first, the cross triple last; the rest (--disable-shared,
    // --libdir, --with-pic, ...) differed from library to library, so each recipe's args: say it
    const configure = [
      `./${build['configure-script'] ?? 'configure'}`,
      `--prefix=${context.depsDir}`,
      ...args(),
      ...(env['CROSS_HOST'] ? [`--host=${env['CROSS_HOST']}`] : []),
    ];
    await run(configure[0]!, configure.slice(1), { cwd: buildSrc, env });
    await run('make', [`-j${context.jobs}`, ...scope.argv(build['make-targets'] ?? [])], {
      cwd: buildSrc,
      env,
    });
    const installTargets = build['install-targets'] ?? ['install'];
    if (installTargets.length) {
      await run('make', scope.argv(installTargets), { cwd: buildSrc, env });
    }
  }
  for (const item of [...build.after, ...extra.after]) {
    await runStep(item, scope, env);
  }
  return crates ? { crates } : {};
}

/**
 * A Rust library from the cache goes through the same licence gate as one just built: the entry may come from a build
 * under another licence (the key doesn't hold it), or licenses.yml may have changed since.
 */
function checkRestoredCrates(
  context: BuildContext,
  library: PlannedLibrary,
  record: SourceRecord,
): void {
  if (!library.build.cargo || !record.crates) {
    return;
  }
  const plan = context.buildPlan;
  if (!plan.cargo) {
    throw new Error(
      `${library.name} builds with cargo, but the build plan has no licence table for its crates (made by an older engine?)`,
    );
  }
  const problems = crateLicenseProblems({
    library: library.name,
    recipeLicense: library.license,
    buildLicense: plan.license,
    table: new Map(Object.entries(plan.cargo.licenses)),
    crates: record.crates.filter((c) => c.linked),
  });
  if (problems.length) {
    throw new Error(`${library.name}'s Rust crates fail the licence check: ${problems.join('; ')}`);
  }
}

export async function buildLibrary(
  context: BuildContext,
  library: PlannedLibrary,
): Promise<SourceRecord> {
  const { cache, depsDir, recipes, sources, work } = context;
  const cached = join(cache, 'libs', `${library.key}.tar.gz`);
  // an entry built from other content than the lock pins (a tag that has since moved) is not used
  const pin =
    'archives' in library.source
      ? { sha256: library.source.sha256 }
      : { commit: library.source.commit };
  // a Rust library's entry must list its crates: one without (an older engine's) is built again
  const restored = await restoreCache(cached, depsDir, sources, library.name, undefined, pin, {
    crates: Boolean(library.build.cargo),
    supplementalSources: Boolean(library.build['source-inventory']),
  });
  if (restored) {
    step(`${library.name} ${library.version}: from cache`);
    checkRestoredCrates(context, library, restored);
    return restored;
  }
  step(`${library.name} ${library.version}: building`);
  const src = join(work, 'src', library.name);
  const fetched = await fetchSource(library.source, src, library.name, sources, work);
  const before = listing(depsDir);
  let built: Awaited<ReturnType<typeof runRecipe>>;
  try {
    built = await runRecipe(context, library, src);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`building ${library.name} ${library.version} failed (see above)${detail}`, {
      cause: error,
    });
  }
  copyLicenses(
    library.name,
    library.version,
    src,
    join(recipes, library.name),
    depsDir,
    library.licenseFiles,
  );
  // (after copyLicenses, which starts the library's legal folder afresh)
  const rust = built.crates
    ? keepCrates(built.crates, { library: library.name, sources, depsDir })
    : undefined;
  if (!fetched.kept) {
    const git = await keepGitSource(src, library.name, sources, work);
    fetched.kept = git.kept;
    fetched.commit = git.commit;
  }
  const record: SourceRecord = {
    ...sourceRecord(library.name, library.version, fetched, sources),
    ...(rust ?? {}),
    ...(library.build['source-inventory']
      ? {
          supplementalSources: keepSupplementalSources(
            src,
            sources,
            library.build['source-inventory'],
          ),
        }
      : {}),
  };
  writeSourceRecord(depsDir, record);
  const files = changedFiles(before, listing(depsDir));
  if (!files.some((file) => !file.startsWith(`${FFB_SHARE}/`))) {
    throw new Error(`${library.name} installed nothing into ${depsDir}`);
  }
  await saveCache(cached, depsDir, files, work);
  return { ...record, cached: false };
}

export function prepareBuildFolders(context: BuildContext): void {
  for (const dir of [
    context.depsDir,
    join(context.depsDir, 'include'),
    join(context.depsDir, 'lib', 'pkgconfig'),
    join(context.work, 'src'),
    join(context.cache, 'libs'),
    context.sources,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
