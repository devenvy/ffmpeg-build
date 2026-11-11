// Which of a platform's conditional `ships:` (platforms.yml `linked:`) a build has, read from FFmpeg's link as it was
// configured and as its linker driver runs it.
//
// ffbuild/config.mak, which FFmpeg's configure writes, holds word for word the flags (LDFLAGS, SHFLAGS, ...) and the
// libraries (EXTRALIBS, EXTRALIBS-<component>) its libraries and programs are linked with, and the driver that links
// them ($(LD): configure's default is the C compiler). The driver adds its own runtimes to every link (libgcc, a
// thread library, compiler-rt and an unwinder): `$(LD) -shared <LDFLAGS> -###` prints the linker command it would run,
// with those libraries and the directories it searches, without linking anything. A library a word names is what the
// linker would take for it: -l:<file> and a path name the file; -l<name> is looked up in the -L directories, then the
// driver's, as ld does (lib<name>.so then lib<name>.a; on Windows the import library first; only the archive while
// the link is static), and a GNU ld script found there (gcc-toolset's libstdc++.so) is followed.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import type { PlannedShip } from './plan.ts';

/** A ships: entry a build has, with what showed it was linked when it is a `linked:` one. */
export interface ShipInBuild extends PlannedShip {
  evidence?: string[]; // `libstdc++.a (EXTRALIBS-avcodec, EXTRALIBS-avfilter)`
  compilerIdent?: string; // configure's CC_IDENT: the compiler that linked it, as it names itself
  // the runtime's version: the linking compiler's, where the toolchain ships the runtime with it (COMPILER_RUNTIMES)
  version?: { value: string; source: string };
  // its notice texts, read once where the build runs (notices.ts shipNotices), for the notices and the SBOM
  read?: { path: string; heading: string; text: string }[];
}

interface Line {
  variable: string;
  words: string[];
}

/** FFmpeg's configured link, as config.mak has it, and what its driver adds. */
export interface ConfiguredLink {
  compilerIdent?: string;
  linker?: string; // config.mak's LD
  flags: Line[];
  libraries: Line[];
  driver?: Line; // the driver's own link command for a shared library (observeDriver)
  programDriver?: Line; // and for a program, where the build has programs
  programs?: boolean; // config.mak: CONFIG_FFMPEG, CONFIG_FFPROBE or CONFIG_FFPLAY
  windows?: boolean; // PE: -l<name> finds an import library first
}

const FLAG_VARIABLES = ['LDFLAGS', 'LDEXEFLAGS', 'LDSOFLAGS', 'SHFLAGS'];
/** How much of a failed driver's stderr an error quotes: its end. */
const STDERR_QUOTE = 500;

/**
 * The link in config.mak: its flags, and the libraries of what is built (EXTRALIBS, and EXTRALIBS-<component> of each
 * component configure enabled: CONFIG_<COMPONENT>=yes; a disabled program's libraries are not linked).
 */
export function configuredLink(configMak: string, windows = false): ConfiguredLink {
  const variables = new Map<string, string>();
  for (const line of configMak.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(line);
    if (match) {
      variables.set(match[1]!, match[2]!);
    }
  }
  const words = (value: string | undefined) => (value ?? '').split(/\s+/).filter(Boolean);
  const built = [...variables.keys()].filter((name) => {
    const component = /^EXTRALIBS-(.+)$/.exec(name)?.[1];
    return component === undefined
      ? name === 'EXTRALIBS'
      : variables.get(`CONFIG_${component.toUpperCase()}`) === 'yes';
  });
  const ident = variables.get('CC_IDENT')?.trim();
  const linker = variables.get('LD')?.trim();
  const programs = ['FFMPEG', 'FFPROBE', 'FFPLAY'].some(
    (program) => variables.get(`CONFIG_${program}`) === 'yes',
  );
  return {
    ...(ident ? { compilerIdent: ident } : {}),
    ...(linker ? { linker } : {}),
    flags: FLAG_VARIABLES.map((variable) => ({ variable, words: words(variables.get(variable)) })),
    libraries: built
      .sort()
      .map((variable) => ({ variable, words: words(variables.get(variable)) })),
    ...(programs ? { programs } : {}),
    ...(windows ? { windows } : {}),
  };
}

/** A command line as a driver's -### prints it: words, each maybe in double or single quotes. */
function commandWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(
    (m) => m[1]?.replace(/\\(.)/g, '$1') ?? m[2] ?? m[3]!,
  );
}

/** The linker command in a driver's -### output (collect2, ld, ld.lld, <triple>-ld...): its arguments. */
export function driverLinkCommand(output: string): string[] | undefined {
  const linkers = output
    .split(/\r?\n/)
    .map(commandWords)
    .filter((words) =>
      /^(?:collect2|(?:\S+-)?ld(?:\.\w+)?|lld|ld64\.lld)(?:\.exe)?$/i.test(
        basename((words[0] ?? '').replaceAll('\\', '/')),
      ),
    );
  return linkers.at(-1)?.slice(1);
}

type Runner = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };
const spawnRunner =
  (env: NodeJS.ProcessEnv): Runner =>
  (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

/**
 * The link commands FFmpeg's linker driver runs with the configured flags, as its -### prints them (nothing is
 * linked): the libraries, startup objects and search directories the driver adds, for a shared library and, where the
 * build has programs, for a program (whose startup objects differ: crt1.o, crt2.o). `object` is any object file of
 * the build.
 */
export function observeDriver(
  link: ConfiguredLink,
  object: string,
  env: NodeJS.ProcessEnv,
  run: Runner = spawnRunner(env),
): ConfiguredLink {
  if (!link.linker) {
    return link;
  }
  const [command, ...preset] = link.linker.split(/\s+/);
  // make's own syntax ($(SUBDIR), $$(@F)) is not the driver's
  const flags = (variables: readonly string[]) =>
    link.flags
      .filter(({ variable }) => variables.includes(variable))
      .flatMap(({ words }) => words)
      .filter((word) => !word.includes('$'));
  const ask = (args: readonly string[], output: string): Line => {
    const label = `${basename(command!)} ${[...args, '-###'].join(' ')}`.replace(/\s+/g, ' ');
    const out = run(command!, [...preset, ...args, '-###', '-o', output, object]);
    const words = out.status === 0 ? driverLinkCommand(`${out.stderr}\n${out.stdout}`) : undefined;
    if (!words) {
      throw new Error(
        `${label} printed no link command (exit ${String(out.status)}): ${out.stderr.trim().slice(-STDERR_QUOTE)}`,
      );
    }
    return { variable: label, words };
  };
  return {
    ...link,
    driver: {
      ...ask(['-shared', ...flags(['LDFLAGS'])], 'ffb-link-probe.so'),
      variable: `${basename(command!)} -shared -###`,
    },
    ...(link.programs
      ? {
          programDriver: {
            ...ask(flags(['LDFLAGS', 'LDEXEFLAGS']), 'ffb-link-probe'),
            variable: `${basename(command!)} -###`,
          },
        }
      : {}),
  };
}

/** The linker driver's version, for a runtime released with it: GCC's -dumpfullversion, clang's -dumpversion. */
export function observeCompilerVersion(
  linker: string,
  env: NodeJS.ProcessEnv,
  run: Runner = spawnRunner(env),
): { value: string; source: string } | undefined {
  const [command, ...preset] = linker.split(/\s+/);
  const clang = /clang/i.test(
    run(command!, [...preset, '--version']).stdout.split(/\r?\n/)[0] ?? '',
  );
  const option = clang ? '-dumpversion' : '-dumpfullversion';
  const out = run(command!, [...preset, option]);
  const value = out.stdout.trim();
  return out.status === 0 && /^\S+$/.test(value)
    ? { value, source: `${basename(command!)} ${option}` }
    : undefined;
}

const STATIC = new Set(['-Bstatic', '-static', '-dn', '-non_shared']);
const DYNAMIC = new Set(['-Bdynamic', '-dy', '-call_shared']);
const MAX_SCRIPT_DEPTH = 4;
const ELF_MAGIC = '\u007fELF';

/** The -L directories of some link words, in order. */
function searchDirs(words: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    for (const part of word.startsWith('-Wl,') ? word.slice('-Wl,'.length).split(',') : [word]) {
      if (part === '-L' && i + 1 < words.length) {
        dirs.push(words[++i]!);
      } else if (part.startsWith('-L') && part.length > '-L'.length) {
        dirs.push(part.slice('-L'.length));
      }
    }
  }
  return dirs;
}

/** Whether a file is a GNU ld script (text where a shared library would be), not an ELF or PE file. */
function isLinkerScript(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(ELF_MAGIC.length);
    readSync(fd, head, 0, head.length, 0);
    const start = head.toString('latin1');
    return start !== ELF_MAGIC && !start.startsWith('MZ') && !start.startsWith('!<ar');
  } finally {
    closeSync(fd);
  }
}

/** How ld finds -l<name>: the static archives that gives (none when it is a shared or import library). */
function resolver(
  dirs: readonly string[],
  windows: boolean,
): (name: string, linkStatic: boolean) => string[] {
  // ld's search and the GNU ld scripts it finds call each other
  const ld = {
    find: (name: string, linkStatic: boolean, depth: number): string[] => {
      let candidates = linkStatic ? [`lib${name}.a`] : [`lib${name}.so`, `lib${name}.a`];
      if (windows) {
        candidates = linkStatic
          ? [`lib${name}.a`, `${name}.lib`]
          : [
              `lib${name}.dll.a`,
              `${name}.dll.a`,
              `lib${name}.a`,
              `${name}.lib`,
              `lib${name}.dll`,
              `${name}.dll`,
            ];
      }
      for (const dir of dirs) {
        for (const candidate of candidates) {
          const path = join(dir, candidate);
          if (existsSync(path) && statSync(path).isFile()) {
            return ld.expand(path, depth);
          }
        }
      }
      return [];
    },
    // a file the link takes: an archive names itself; a GNU ld script names what it INPUTs or GROUPs
    expand: (path: string, depth: number): string[] => {
      if (path.endsWith('.a') && !path.endsWith('.dll.a')) {
        return [basename(path)];
      }
      if (!path.endsWith('.so') || depth >= MAX_SCRIPT_DEPTH || !isLinkerScript(path)) {
        return [];
      }
      const script = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      return [...script.matchAll(/\b(?:INPUT|GROUP)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)].flatMap(
        (m) =>
          m[1]!
            .replace(/AS_NEEDED\s*\(([^)]*)\)/g, ' $1 ')
            .split(/[\s,]+/)
            .filter(Boolean)
            .flatMap((item) => {
              if (item.startsWith('-l')) {
                return ld.find(item.slice('-l'.length), false, depth + 1);
              }
              if (isAbsolute(item) && existsSync(item)) {
                return ld.expand(item, depth + 1);
              }
              // a bare name: ld looks for it in the search path
              return item.endsWith('.a') ? [item] : [];
            }),
      );
    },
  };
  return (name, linkStatic) => ld.find(name, linkStatic, 0);
}

/**
 * The static archives some link words name: -l:<file>, a path, and each -l<name> as `resolve` finds it (without a
 * resolver, -l<name> counts only where the link is static: the driver's -static, or the linker's -Bstatic until
 * -Bdynamic, as passed with -Wl, or -Xlinker, with --push-state/--pop-state).
 */
function scan(
  words: readonly string[],
  startStatic: boolean,
  resolve?: (name: string, linkStatic: boolean) => string[],
): { named: string[]; endsStatic: boolean } {
  const named: string[] = [];
  let linkStatic = startStatic;
  const saved: boolean[] = [];
  const library = (word: string) => {
    if (word.startsWith('-l:')) {
      named.push(word.slice('-l:'.length));
    } else if (word.startsWith('-l') && word.length > '-l'.length) {
      const name = word.slice('-l'.length);
      if (resolve) {
        named.push(...resolve(name, linkStatic));
      } else if (linkStatic) {
        named.push(`lib${name}.a`);
      }
    } else if (!word.startsWith('-') && /\.[ao]$/.test(word) && !word.endsWith('.dll.a')) {
      // an archive, or an object such as a C runtime's startup file (crti.o, dllcrt2.o)
      named.push(word.split(/[\\/]/).at(-1)!);
    }
  };
  const linker = (argument: string) => {
    if (STATIC.has(argument)) {
      linkStatic = true;
    } else if (DYNAMIC.has(argument)) {
      linkStatic = false;
    } else if (argument === '--push-state') {
      saved.push(linkStatic);
    } else if (argument === '--pop-state') {
      linkStatic = saved.pop() ?? linkStatic;
    } else {
      library(argument);
    }
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith('-Wl,')) {
      word.slice('-Wl,'.length).split(',').filter(Boolean).forEach(linker);
    } else if (word === '-Xlinker' && i + 1 < words.length) {
      linker(words[++i]!);
    } else if (word === '-L' || word === '-o') {
      i++;
    } else {
      linker(word);
    }
  }
  return { named, endsStatic: linkStatic };
}

/** Where the link shows one `linked:` item: the variables naming the archive, or giving the flag. */
function shown(link: ConfiguredLink, item: string): string[] {
  const drivers = [link.driver, link.programDriver].filter((line) => line !== undefined);
  if (item.startsWith('-')) {
    return [...link.flags, ...link.libraries]
      .filter(({ words }) => words.includes(item))
      .map(({ variable }) => variable);
  }
  const flagWords = link.flags.flatMap(({ words }) => words);
  // the flags come first on every link line: the driver's -static, or a -Bstatic they leave on, covers the libraries
  const startStatic = scan(flagWords, false).endsStatic;
  // ld searches the -L directories in order (the flags', then the line's), then the driver's own; without the
  // driver's command, only what is named outright, or found static in a static link, counts
  const userDirs = searchDirs(flagWords);
  const driverDirs = drivers.length
    ? [...new Set(drivers.flatMap(({ words }) => searchDirs(words)))].filter(
        (dir) => !userDirs.includes(dir),
      )
    : undefined;
  const resolve = (words: readonly string[]) =>
    driverDirs
      ? resolver([...userDirs, ...searchDirs(words), ...driverDirs], link.windows ?? false)
      : undefined;
  return [
    ...link.flags.filter(({ words }) => scan(words, false, resolve(words)).named.includes(item)),
    ...link.libraries.filter(({ words }) =>
      scan(words, startStatic, resolve(words)).named.includes(item),
    ),
    ...drivers.filter(({ words }) => scan(words, false, resolve([])).named.includes(item)),
  ].map(({ variable }) => variable);
}

/**
 * The ships: entries a build has: each without `linked:`, and each `linked:` one whose evidence the link shows (with
 * what showed it), for its `compiler:` when it names one. A runtime the toolchain releases with its compiler
 * (`compilerRuntimes`, from its COMPILER_RUNTIMES) gets the linking compiler's version.
 */
export function shipsInBuild(
  ships: readonly PlannedShip[],
  link: ConfiguredLink,
  compiler: { runtimes: readonly string[]; version?: { value: string; source: string } } = {
    runtimes: [],
  },
): ShipInBuild[] {
  return ships.flatMap((ship): ShipInBuild[] => {
    if (!ship.linked) {
      return [ship];
    }
    if (ship.compiler) {
      if (!link.compilerIdent) {
        throw new Error(
          `FFmpeg's ffbuild/config.mak has no CC_IDENT, which platforms.yml's ${ship.file} (compiler: ${ship.compiler}) needs`,
        );
      }
      // gcc 15.2.0 (Alpine 15.2.0), clang version 21.1.0 (...), Alpine clang version 20.1.8
      if (!link.compilerIdent.split(/\s+/).includes(ship.compiler)) {
        return [];
      }
    }
    const evidence = ship.linked.flatMap((item) => {
      const where = shown(link, item);
      return where.length ? [`${item} (${where.join(', ')})`] : [];
    });
    return evidence.length
      ? [
          {
            ...ship,
            evidence,
            ...(link.compilerIdent ? { compilerIdent: link.compilerIdent } : {}),
            ...(compiler.version && compiler.runtimes.includes(ship.file)
              ? { version: compiler.version }
              : {}),
          },
        ]
      : [];
  });
}
