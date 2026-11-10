// Which of a platform's conditional `ships:` (platforms.yml `linked:`) a build has, read from FFmpeg's configured link.
// ffbuild/config.mak, which FFmpeg's configure writes, holds word for word the flags (LDFLAGS, SHFLAGS, ...) and the
// libraries (EXTRALIBS, EXTRALIBS-<component>) its libraries and programs are linked with. FFmpeg links with its C
// compiler driver ($(LD), configure's default: the C compiler), which adds no C++ runtime of its own: a C++ runtime
// reaches FFmpeg's link only as a word there (a library's .pc file, or configure's own -lstdc++), so a static archive
// the link names there is what the linker took it from. A compiler-driver flag (-static-libgcc) is read the same way.
// What the linker resolves by searching (-lunwind where only libunwind.a exists) is not seen: name the archive.
import type { PlannedShip } from './plan.ts';

/** A ships: entry a build has, with what showed it was linked when it is a `linked:` one. */
export interface ShipInBuild extends PlannedShip {
  evidence?: string[]; // `-l:libstdc++.a (EXTRALIBS-avcodec, EXTRALIBS-avfilter)`
  compilerIdent?: string; // configure's CC_IDENT: the compiler that linked it, as it names itself
}

/** FFmpeg's configured link, as config.mak has it. */
export interface ConfiguredLink {
  compilerIdent?: string;
  flags: { variable: string; words: string[] }[];
  libraries: { variable: string; words: string[] }[];
}

const FLAG_VARIABLES = ['LDFLAGS', 'LDEXEFLAGS', 'LDSOFLAGS', 'SHFLAGS'];

/**
 * The link in config.mak: its flags, and the libraries of what is built (EXTRALIBS, and EXTRALIBS-<component> of each
 * component configure enabled: CONFIG_<COMPONENT>=yes; a disabled program's libraries are not linked).
 */
export function configuredLink(configMak: string): ConfiguredLink {
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
  return {
    ...(ident ? { compilerIdent: ident } : {}),
    flags: FLAG_VARIABLES.map((variable) => ({ variable, words: words(variables.get(variable)) })),
    libraries: built
      .sort()
      .map((variable) => ({ variable, words: words(variables.get(variable)) })),
  };
}

const STATIC = new Set(['-Bstatic', '-static', '-dn', '-non_shared']);
const DYNAMIC = new Set(['-Bdynamic', '-dy', '-call_shared']);

/**
 * The libraries a list of link words names, each as its file when that is a static archive: -l:<file>, a path, or
 * -l<name> while the link is static (the driver's -static, or the linker's -Bstatic until -Bdynamic, as passed with
 * -Wl, or -Xlinker, with --push-state/--pop-state).
 */
function scan(
  words: readonly string[],
  startStatic: boolean,
): { named: string[]; endsStatic: boolean } {
  const named: string[] = [];
  let linkStatic = startStatic;
  const saved: boolean[] = [];
  const library = (word: string) => {
    if (word.startsWith('-l:')) {
      named.push(word.slice('-l:'.length));
    } else if (word.startsWith('-l') && word.length > '-l'.length) {
      if (linkStatic) {
        named.push(`lib${word.slice('-l'.length)}.a`);
      }
    } else if (!word.startsWith('-') && word.endsWith('.a')) {
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
    } else if (word === '-static') {
      linkStatic = true;
    } else {
      library(word);
    }
  }
  return { named, endsStatic: linkStatic };
}

/** Where the link shows one `linked:` item: the variables naming the archive, or giving the flag. */
function shown(link: ConfiguredLink, item: string): string[] {
  if (item.startsWith('-')) {
    return [...link.flags, ...link.libraries]
      .filter(({ words }) => words.includes(item))
      .map(({ variable }) => variable);
  }
  // the flags come first on every link line: the driver's -static, or a -Bstatic they leave on, covers the libraries
  const startStatic = scan(
    link.flags.flatMap(({ words }) => words),
    false,
  ).endsStatic;
  return [
    ...link.flags.filter(({ words }) => scan(words, false).named.includes(item)),
    ...link.libraries.filter(({ words }) => scan(words, startStatic).named.includes(item)),
  ].map(({ variable }) => variable);
}

/**
 * The ships: entries a build has: each without `linked:`, and each `linked:` one whose evidence the configured link
 * shows (with what showed it), for its `compiler:` when it names one.
 */
export function shipsInBuild(ships: readonly PlannedShip[], link: ConfiguredLink): ShipInBuild[] {
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
          },
        ]
      : [];
  });
}
