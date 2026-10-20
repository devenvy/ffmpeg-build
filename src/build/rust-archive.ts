// A Rust static library carries its own copy of Rust's standard library (and of every crate it compiles in), under
// the names every Rust library built by the same rustc gives them: two in one link (rav1e and librsvg in one FFmpeg)
// define the same symbols twice, and the link fails (devenvy/ffmpeg-build#48). So once a Rust library is built, every
// symbol its Rust objects define, but its C API (the recipe's cargo: exports:), takes the library's own prefix,
// consistently in all of its Rust objects (objcopy --redefine-syms): each library then calls its own copy of Rust, as
// two Rust shared libraries in one process would, and nothing it links collides with another. Its C, assembly and
// import members are left as they are. Apple's Xcode has no objcopy, and rav1e is the only Rust library built there.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { run } from './run.ts';

export interface ArchiveMember {
  name: string;
  data: Buffer;
}

const MAGIC = '!<arch>\n';
const HEADER = 60;
const NAME_FIELD = 16;
const SIZE_AT = 48;
const SIZE_FIELD = 10;
const DATE_FIELD = 12;
const ID_FIELD = 6;
const MODE_FIELD = 8;
/** A GNU archive keeps a name this long or shorter in the member's header (with its closing slash). */
const SHORT_NAME = 15;
const BSD_NAME = '#1/';
const DECIMAL = 10;
const EVEN = 2;
/** How many of a library's C names an exports: error shows. */
const SHOWN_NAMES = 3;
const APPLE = /^(osx|ios|maccatalyst)-/;
/** The objects rustc writes: each codegen unit, named <crate>-<hash>.<crate>.<hash>-cgu.<n>.rcgu.o (and so on). */
const isRustObject = (name: string) => name.endsWith('.rcgu.o');

/** The members of an ar archive (GNU, COFF or BSD format), in order, without its symbol index or long-name table. */
export function readArchive(bytes: Buffer, what: string): ArchiveMember[] {
  if (bytes.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) {
    throw new Error(`${what} is not an ar archive`);
  }
  const members: ArchiveMember[] = [];
  let longNames: Buffer = Buffer.alloc(0);
  let at = MAGIC.length;
  while (at + HEADER <= bytes.length) {
    const head = bytes.subarray(at, at + HEADER).toString('latin1');
    const raw = head.slice(0, NAME_FIELD).trimEnd();
    const size = Number.parseInt(head.slice(SIZE_AT, SIZE_AT + SIZE_FIELD), DECIMAL);
    const start = at + HEADER;
    if (!Number.isFinite(size) || start + size > bytes.length) {
      throw new Error(`${what} ends inside its member ${raw.replace(/\/$/, '')}`);
    }
    let data = bytes.subarray(start, start + size);
    at = start + size + (size % EVEN);
    let name: string | undefined;
    if (raw === '//') {
      longNames = data;
    } else if (raw.startsWith(BSD_NAME)) {
      const length = Number.parseInt(raw.slice(BSD_NAME.length), DECIMAL);
      name = data.subarray(0, length).toString('utf8').replace(/\0+$/, '');
      data = data.subarray(length);
    } else if (/^\/\d+$/.test(raw)) {
      const text = longNames.subarray(Number.parseInt(raw.slice(1), DECIMAL)).toString('utf8');
      name = text.slice(0, text.search(/\/?\n|\0|$/));
    } else if (!raw.startsWith('/')) {
      name = raw.replace(/\/$/, '');
    }
    // (another name starting with /: the symbol index, `/` or `/SYM64/`, COFF's two linker members, and the like)
    if (name !== undefined && !name.startsWith('__.SYMDEF')) {
      members.push({ name, data: Buffer.from(data) });
    }
  }
  return members;
}

/** A GNU-format archive of these members, in this order, with no time, owner or group in it (and no symbol index). */
export function writeArchive(members: readonly ArchiveMember[]): Buffer {
  const header = (name: string, size: number) =>
    Buffer.from(
      [
        name.padEnd(NAME_FIELD),
        '0'.padEnd(DATE_FIELD),
        '0'.padEnd(ID_FIELD),
        '0'.padEnd(ID_FIELD),
        '644'.padEnd(MODE_FIELD),
        String(size).padEnd(SIZE_FIELD),
        '`\n',
      ].join(''),
      'latin1',
    );
  const pad = (size: number) => Buffer.from(size % EVEN ? '\n' : '');
  let table = '';
  const named = members.map((m) => {
    if (m.name.length <= SHORT_NAME && !/[/\s]/.test(m.name)) {
      return { ...m, field: `${m.name}/` };
    }
    const field = `/${Buffer.byteLength(table)}`;
    table += `${m.name}/\n`;
    return { ...m, field };
  });
  const parts: Buffer[] = [Buffer.from(MAGIC, 'latin1')];
  if (table) {
    const bytes = Buffer.from(table);
    parts.push(header('//', bytes.length), bytes, pad(bytes.length));
  }
  for (const m of named) {
    parts.push(header(m.field, m.data.length), m.data, pad(m.data.length));
  }
  return Buffer.concat(parts);
}

const globRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);

/** A name only Rust gives: mangled (v0 _R, legacy _ZN), LLVM's promoted locals, Rust's runtime (rust_eh_personality). */
const RUST_NAME = /^_?_R|^_?_ZN|rust|^anon\.|\.llvm\./;

/**
 * What to rename in a Rust library, from `nm -P -A -g` of it: every symbol its Rust objects define, but its C API
 * (`exports`, globs) and the weak C-named ones (compiler_builtins' ceil and the like, which never collide), each to
 * `ffb.<library>.<name>`.
 */
export function rustRenames(
  nm: string,
  a: { library: string; exports: readonly string[] },
): Map<string, string> {
  const exports = a.exports.map((glob) => ({ glob, regex: globRegex(glob) }));
  const defined = new Set<string>();
  const cNames = new Set<string>(); // what a C API's names look like: strong, not Rust's, no leading underscore
  const renames = new Map<string, string>();
  const found = nm.split(/\r?\n/).flatMap((line) => {
    const m = /^.*\[([^\]]+)\]: (\S+) (\S)(?: |$)/.exec(line);
    // U: undefined; w and v: undefined weak; I: an indirect (import) symbol
    return m && isRustObject(m[1]!) && !'UwvI'.includes(m[3]!)
      ? [{ symbol: m[2]!, type: m[3]! }]
      : [];
  });
  for (const { symbol, type } of found) {
    defined.add(symbol);
    const weak = type === 'W' || type === 'V';
    if (!weak && !RUST_NAME.test(symbol) && !symbol.startsWith('_')) {
      cNames.add(symbol);
    }
    if (!exports.some((e) => e.regex.test(symbol)) && (!weak || RUST_NAME.test(symbol))) {
      renames.set(symbol, `ffb.${a.library}.${symbol}`);
    }
  }
  const unmatched = exports.filter((e) => ![...defined].some((s) => e.regex.test(s)));
  if (unmatched.length) {
    const api = [...cNames].sort();
    const more = api.length > SHOWN_NAMES ? ', ...' : '';
    const shown = api.length
      ? ` (its C names: ${api.slice(0, SHOWN_NAMES).join(', ')}${more})`
      : '';
    throw new Error(
      `${a.library}: cargo: exports: names ${unmatched.map((e) => e.glob).join(', ')}, which no Rust object in the library defines${shown}: make exports: match the library's C API`,
    );
  }
  return renames;
}

/** nm, objcopy and ar for the platform's objects: by the toolchain's NM, its cross prefix, or the plain names. */
export function rustTools(
  env: NodeJS.ProcessEnv,
  platform: string,
): { nm: string; objcopy: string; ar: string } | undefined {
  if (APPLE.test(platform)) {
    return undefined;
  }
  const prefix = env['CROSS_PREFIX'] ? `${env['CROSS_PREFIX']}-` : '';
  const nm = env['NM'] ?? `${prefix}nm`;
  return {
    nm,
    objcopy: nm.replace(/nm$/, 'objcopy'),
    ar: env['AR'] ?? `${prefix}ar`,
  };
}

/**
 * Why these Rust libraries (recipes with cargo:) can't link into one build on the platform, if they can't: two or
 * more where the engine can't give each its own names (Apple).
 */
export function rustLinkProblem(rust: readonly string[], platform: string): string | undefined {
  return rust.length > 1 && !rustTools({}, platform)
    ? `${rust.join(' and ')} are Rust static libraries, each with its own copy of Rust's standard library, which can't link into one ${platform} build: the engine gives each copy its own names with objcopy, which Xcode hasn't got (leave all but one out)`
    : undefined;
}

/**
 * Gives a Rust static library's copy of Rust its own names (above), in place. Returns how many symbols it renamed:
 * none for an archive with no Rust object, or on Apple.
 */
export async function isolateRustArchive(
  path: string,
  a: {
    library: string;
    exports: readonly string[];
    env: NodeJS.ProcessEnv;
    platform: string;
    work: string;
  },
): Promise<number> {
  const members = readArchive(readFileSync(path), path);
  const tools = rustTools(a.env, a.platform);
  if (!tools || !members.some((m) => isRustObject(m.name))) {
    return 0;
  }
  const renames = rustRenames(
    await run(tools.nm, ['-P', '-A', '-g', path], { env: a.env, capture: true }),
    a,
  );
  // the Rust objects alone, each by a name of its own, through objcopy (which can't read every member a library
  // may hold: the import members Rust's windows-gnullvm libraries carry)
  const dir = join(a.work, `rust-archive-${a.library}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const rust = members.flatMap((m, i) => (isRustObject(m.name) ? [i] : []));
    const map = join(dir, 'renames.txt');
    writeFileSync(map, [...renames].map(([from, to]) => `${from} ${to}\n`).join(''));
    const input = join(dir, 'rust.a');
    const output = join(dir, 'renamed.a');
    writeFileSync(
      input,
      writeArchive(rust.map((i) => ({ name: `${i}.o`, data: members[i]!.data }))),
    );
    await run(tools.objcopy, [`--redefine-syms=${map}`, input, output], { env: a.env });
    const renamed = readArchive(readFileSync(output), output);
    if (renamed.length !== rust.length) {
      throw new Error(
        `${a.library}: objcopy gave back ${renamed.length} of the ${rust.length} Rust objects of ${path}`,
      );
    }
    rust.forEach((i, n) => {
      members[i] = { name: members[i]!.name, data: renamed[n]!.data };
    });
    writeFileSync(path, writeArchive(members));
    await run(tools.ar, ['s', path], { env: a.env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return renames.size;
}
