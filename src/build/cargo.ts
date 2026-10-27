// The crates a Rust library (a recipe with `cargo:`) compiles in: fetched once against its Cargo.lock, listed by cargo
// for the platform's Rust target, checked against licenses.yml before anything is built, and kept: each crates.io
// crate's .crate file (the sha256 Cargo.lock pins) for the sources archive, and each linked crate's licence texts for
// THIRD-PARTY-NOTICES.txt. The Rust standard library, linked into every Rust static library, is noted too.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { allowedBy, type LicenseTable } from '../licenses.ts';
import { FFB_SHARE } from './cache.ts';
import { keepSource, sha256 } from './fetch.ts';
import { run } from './run.ts';

import type { License } from '../schema/profile.ts';

/** One crate a Rust library's build compiles, as its source record keeps it. */
export interface CrateRecord {
  name: string;
  version: string;
  license?: string; // the SPDX expression its Cargo.toml gives (of every crate linked in; others, when resolved)
  source: 'crates.io' | 'path'; // a crates.io crate, or a path dependency inside the library's own source
  file?: string; // crates.io: the kept .crate, under the cache's sources/
  sha256?: string; // crates.io: the .crate's sha256, which Cargo.lock pins
  linked: boolean; // linked into the library (else a source only: build scripts', procedural macros', other platforms' or tests' crates)
  texts: string[]; // its licence files, under legal/<library>/crates/<name>-<version>/ (linked crates only)
  standard?: string[]; // no licence file: the SPDX ids whose standard text stands in (reviewed: cargo.standard-texts)
  authors?: string[]; // with standard: the authors its Cargo.toml names
}

/** The Rust standard library a Rust library links: the toolchain's version, and its notices beside the library. */
export interface RustRecord {
  version: string;
  texts: string[]; // under legal/<library>/rust/
}

interface FoundCrate extends Omit<CrateRecord, 'file' | 'texts'> {
  crateFile?: string;
  licenceFiles: { from: string; name: string }[];
}

export interface CrateInventory {
  library: string;
  root: { name: string; version: string; license: string };
  crates: FoundCrate[];
  rustVersion: string;
  rustNotices: string; // the toolchain's COPYRIGHT-library.html
}

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
/** A crate's licence files: in its root, by the names crates use, or in a LICENSES/ folder (REUSE). */
const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|patents)/i;
const LICENCE_DIR = /^licen[cs]es$/i;
/** `WITH` and the exception named after it. */
const WITH_CLAUSE_TOKENS = 2;

/** An SPDX expression as crates write it, in the form licenses.yml reads: old-style `/` and lower-case operators. */
export function normalizeSpdx(expression: string): string {
  return (expression.replaceAll('/', ' OR ').match(/\(|\)|[^\s()]+/g) ?? [])
    .map((t) => (/^(or|and|with)$/i.test(t) ? t.toUpperCase() : t))
    .join(' ')
    .replaceAll('( ', '(')
    .replaceAll(' )', ')');
}

/** The ways to satisfy an SPDX expression: each a list of licence ids (`X WITH e` is one) that together do. */
export function spdxBranches(expression: string): string[][] {
  const tokens = normalizeSpdx(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const invalid = () => new Error(`not an SPDX expression the engine can read: ${expression}`);
  function atom(): string[][] {
    const t = tokens[i++];
    if (t === undefined || t === ')' || t === 'AND' || t === 'OR' || t === 'WITH') {
      throw invalid();
    }
    if (t === '(') {
      const inner = or();
      if (tokens[i++] !== ')') {
        throw invalid();
      }
      return inner;
    }
    if (tokens[i] === 'WITH') {
      const exception = tokens[i + 1];
      if (exception === undefined || exception === '(' || exception === ')') {
        throw invalid();
      }
      i += WITH_CLAUSE_TOKENS;
      return [[`${t} WITH ${exception}`]];
    }
    return [[t]];
  }
  function and(): string[][] {
    let branches = atom();
    while (tokens[i] === 'AND') {
      i++;
      const next = atom();
      branches = branches.flatMap((a) => next.map((b) => [...new Set([...a, ...b])]));
    }
    return branches;
  }
  function or(): string[][] {
    const branches = and();
    while (tokens[i] === 'OR') {
      i++;
      branches.push(...and());
    }
    return branches;
  }
  const result = or();
  if (i !== tokens.length) {
    throw invalid();
  }
  return result;
}

const allowedIn = (expression: string, table: LicenseTable) =>
  allowedBy(normalizeSpdx(expression), table);

/**
 * Why crates linked into a library may not be: a licence the engine can't read or licenses.yml has no entry for; one
 * the recipe's own `license:` doesn't name (what `check` reads before any build: it must name all that is linked in);
 * one that would let the recipe go into builds the crate may not (`MIT OR Apache-2.0` naming an Apache-2.0 crate);
 * and one the build's licence may not carry (a GPL crate in an LGPL build).
 */
export function crateLicenseProblems(a: {
  library: string;
  recipeLicense: string;
  buildLicense?: License | undefined;
  table: LicenseTable;
  crates: readonly { name: string; version: string; license?: string | undefined }[];
}): string[] {
  const recipeIds = new Set(
    (() => {
      try {
        return spdxBranches(a.recipeLicense).flat();
      } catch {
        return [];
      }
    })(),
  );
  const recipe = allowedIn(a.recipeLicense, a.table);
  const problems: string[] = [];
  for (const { name, version, license = '' } of a.crates) {
    const c = { name, version, license };
    const what = `${c.name} ${c.version} is under ${c.license || '(no licence)'}`;
    const verdict = allowedIn(c.license, a.table);
    if ('invalid' in verdict) {
      problems.push(`${what}, which isn't an SPDX expression the engine can read`);
    } else if ('unknown' in verdict) {
      problems.push(
        `${what}, which licenses.yml has no entry for (${verdict.unknown.join(', ')}): add one, saying which builds may carry it`,
      );
    } else if (!spdxBranches(c.license).some((branch) => branch.every((id) => recipeIds.has(id)))) {
      problems.push(
        `${what}, which ${a.library}'s license: (${a.recipeLicense}) doesn't name: add it to recipes/${a.library}/recipe.yml's license:`,
      );
    } else if (a.buildLicense && !verdict.allowed.includes(a.buildLicense)) {
      problems.push(
        `${what}, which a ${a.buildLicense} build may not carry (licenses.yml allows it in ${verdict.allowed.join(', ') || 'none'})`,
      );
    } else if ('allowed' in recipe && recipe.allowed.some((l) => !verdict.allowed.includes(l))) {
      problems.push(
        `${what}, which only ${verdict.allowed.join(', ')} builds may carry, but ${a.library}'s license: (${a.recipeLicense}) allows ${recipe.allowed.join(', ')}: make it name ${c.license} with AND`,
      );
    }
  }
  return problems;
}

/** Cargo.lock's packages: name, version, source (none for the workspace's own) and checksum (a registry's). */
function lockPackages(
  text: string,
): { name: string; version: string; source: string; checksum: string }[] {
  return text
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .map((block) => {
      const field = (name: string) =>
        new RegExp(`^${name} = "([^"]*)"$`, 'm').exec(block)?.[1] ?? '';
      return {
        name: field('name'),
        version: field('version'),
        source: field('source'),
        checksum: field('checksum'),
      };
    });
}

interface Package {
  name: string;
  version: string;
  source: string | null;
  license: string | null;
  license_file: string | null;
  authors: string[];
  manifest_path: string;
}

/** `name v1.2.3 (...)|licence` lines of `cargo tree --format {p}|{l}`, as name@version, each once. */
function treeCrates(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+) v(\S+)/.exec(line.slice(0, Math.max(0, line.lastIndexOf('|'))));
    if (match?.[1] && match[2]) {
      found.add(`${match[1]}@${match[2]}`);
    }
  }
  return [...found];
}

function inside(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path));
  return !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

function licenceFiles(dir: string, licenseFile: string | null): { from: string; name: string }[] {
  const files: { from: string; name: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && LICENCE_FILE.test(entry.name)) {
      files.push({ from: join(dir, entry.name), name: entry.name });
    } else if (entry.isDirectory() && LICENCE_DIR.test(entry.name)) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile()) {
          files.push({
            from: join(dir, entry.name, inner.name),
            name: `${entry.name}/${inner.name}`,
          });
        }
      }
    }
  }
  const named = licenseFile?.replaceAll('\\', '/');
  if (named && !files.some((f) => f.name === named) && existsSync(join(dir, named))) {
    files.push({ from: join(dir, named), name: named });
  }
  return files.sort((x, y) => (x.name < y.name ? -1 : 1));
}

/**
 * The crates of a library's Cargo.lock: every one fetched (`--locked`: each checked against Cargo.lock's checksum),
 * as `cargo vendor` would hold them, since cargo-c reads the metadata of all of them and the build is offline from
 * here; then listed offline. Linked into the library: `cargo tree -e normal,no-proc-macro` for the target, with the
 * features the build selects. The rest (build scripts', procedural macros', other platforms' and tests' crates) are
 * kept as sources only.
 */
export async function discoverCrates(a: {
  library: string;
  src: string;
  env: NodeJS.ProcessEnv;
  target: string;
  package: string;
  features: readonly string[];
  standardTexts: readonly string[]; // crates reviewed to take the standard text of their licence (they ship none)
  textIds: readonly string[]; // the SPDX ids the engine has standard texts of (license-texts/)
  table: LicenseTable;
}): Promise<CrateInventory> {
  const cargo = async (args: string[]) =>
    run('cargo', args, { cwd: a.src, env: a.env, capture: true });
  const fail = (message: string): never => {
    throw new Error(`${a.library}: ${message}`);
  };
  const about = await run('rustc', ['-vV'], { cwd: a.src, env: a.env, capture: true });
  const rustVersion =
    /^release: (\S+)$/m.exec(about)?.[1] ?? fail(`rustc -vV names no release:\n${about}`);
  await cargo(['fetch', '--locked']);
  const metadata = JSON.parse(
    await cargo(['metadata', '--format-version', '1', '--locked', '--offline']),
  ) as { packages: Package[] };
  const linked = new Set(
    treeCrates(
      await cargo([
        'tree',
        '--locked',
        '--offline',
        '-p',
        a.package,
        ...(a.features.length ? ['-F', a.features.join(',')] : []),
        '--target',
        a.target,
        '-e',
        'normal,no-proc-macro',
        '--prefix',
        'none',
        '--format',
        '{p}|{l}',
      ]),
    ),
  );
  const keyOf = (p: Package) => `${p.name}@${p.version}`;
  for (const key of linked) {
    const found = metadata.packages.filter((p) => keyOf(p) === key);
    if (found.length !== 1) {
      fail(`cargo metadata has ${found.length} packages ${key}, where cargo tree has one`);
    }
  }
  const root = metadata.packages.find((p) => p.source === null && p.name === a.package);
  const lock = lockPackages(readFileSync(join(a.src, 'Cargo.lock'), 'utf8'));
  const elsewhere = lock.find((p) => p.source && p.source !== CRATES_IO);
  if (elsewhere) {
    fail(
      `${elsewhere.name} ${elsewhere.version} comes from ${elsewhere.source}; only crates.io crates and path dependencies inside the source are kept`,
    );
  }
  // where cargo fetch keeps the downloads: registry/cache/<index>/, beside registry/src/<index>/<name>-<version>/,
  // which holds the crates cargo metadata resolved
  const resolved = metadata.packages.find((p) => p.source === CRATES_IO);
  const cache = resolved
    ? join(dirname(dirname(dirname(dirname(resolved.manifest_path)))), 'cache')
    : '';
  const index = resolved ? basename(dirname(dirname(resolved.manifest_path))) : '';
  const crates = [
    // every crates.io crate Cargo.lock names (as cargo vendor keeps them: a vendored build needs all of them, even
    // what no enabled feature uses), with what cargo metadata says of those it resolved
    ...lock
      .filter((l) => l.source === CRATES_IO)
      .map((l) =>
        inspectCrate(
          {
            name: l.name,
            version: l.version,
            checksum: l.checksum,
            crateFile: join(cache, index, `${l.name}-${l.version}.crate`),
            ...pick(metadata.packages, l.name, l.version, CRATES_IO),
          },
          linked.has(`${l.name}@${l.version}`),
          { ...a, fail },
        ),
      ),
    // the path dependencies linked in: part of the library's own source
    ...metadata.packages
      .filter((p) => p.source === null && p !== root && linked.has(keyOf(p)))
      .map((p) => inspectCrate({ ...p, package: p }, true, { ...a, fail })),
  ].sort((x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version));
  const sysroot = (
    await run('rustc', ['--print', 'sysroot'], { cwd: a.src, env: a.env, capture: true })
  ).trim();
  const rustNotices = join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html');
  if (!existsSync(rustNotices)) {
    fail(`the Rust toolchain has no ${rustNotices}: the standard library's notices`);
  }
  return {
    library: a.library,
    root: root
      ? { name: root.name, version: root.version, license: root.license ?? '' }
      : fail(`cargo metadata has no package ${a.package} in the source`),
    crates,
    rustVersion,
    rustNotices,
  };
}

/** The package cargo metadata resolved of this name, version and source, if it did. */
function pick(
  packages: readonly Package[],
  name: string,
  version: string,
  source: string | null,
): { package?: Package } {
  const found = packages.find(
    (p) => p.name === name && p.version === version && p.source === source,
  );
  return found ? { package: found } : {};
}

/**
 * One crate: where it comes from, its .crate (a crates.io crate's, checked against Cargo.lock's checksum), and, linked
 * into the library, its licence and licence texts (from the package cargo metadata resolved).
 */
function inspectCrate(
  c: { name: string; version: string; package?: Package; checksum?: string; crateFile?: string },
  isLinked: boolean,
  a: {
    library: string;
    src: string;
    standardTexts: readonly string[];
    textIds: readonly string[];
    table: LicenseTable;
    fail: (message: string) => never;
  },
): FoundCrate {
  const { fail } = a;
  const what = `${c.name} ${c.version}`;
  const p = c.package;
  const dir = p ? dirname(p.manifest_path) : '';
  if (p?.source === null && !inside(a.src, dir)) {
    fail(
      `${what} is a path dependency outside the source (${dir}), which the sources archive wouldn't hold`,
    );
  }
  if (isLinked && !p) {
    fail(`cargo tree links in ${what}, which cargo metadata didn't resolve`);
  }
  const license = isLinked
    ? (p!.license ??
      fail(
        p!.license_file
          ? `${what} names no SPDX licence (only its licence file ${p!.license_file}): licenses.yml can't say where it may go`
          : `${what} names no licence`,
      ))
    : (p?.license ?? undefined);
  const crate: FoundCrate = {
    name: c.name,
    version: c.version,
    ...(license ? { license } : {}),
    source: c.crateFile ? 'crates.io' : 'path',
    linked: isLinked,
    licenceFiles: isLinked ? licenceFiles(dir, p!.license_file) : [],
  };
  if (c.crateFile) {
    crate.crateFile = c.crateFile;
    if (!existsSync(crate.crateFile) || !statSync(crate.crateFile).isFile()) {
      fail(`${what}'s .crate isn't where cargo fetch keeps it (${crate.crateFile})`);
    }
    crate.sha256 = sha256(crate.crateFile);
    if (crate.sha256 !== c.checksum) {
      fail(
        `${what}'s .crate has sha256 ${crate.sha256}, not the ${c.checksum?.length ? c.checksum : '(none)'} Cargo.lock pins`,
      );
    }
  }
  // (a path dependency is part of the library's own source, whose license-files cover it)
  if (license && p && crate.linked && crate.source === 'crates.io' && !crate.licenceFiles.length) {
    if (!a.standardTexts.includes(c.name)) {
      fail(
        `the crate ${what} (${license}) ships no licence file: check its source and, if the standard text of its licence covers it, add it to recipes/${a.library}/recipe.yml's cargo: standard-texts:`,
      );
    }
    // the alternative with texts the engine has that the most builds may carry
    const allowed = (ids: string[]) => {
      const verdict = allowedBy(ids.join(' AND '), a.table);
      return 'allowed' in verdict ? verdict.allowed.length : -1;
    };
    const branch = spdxBranches(license)
      .filter((ids) => ids.every((id) => a.textIds.includes(id)))
      .sort((x, y) => allowed(y) - allowed(x))[0];
    crate.standard =
      branch ?? fail(`the engine has no standard text (license-texts/) for ${what}'s ${license}`);
    crate.authors = p.authors;
  }
  return crate;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const HEX = 16;
const SKIPPED_TAGS = new Set(['style', 'script']);
const BLOCK_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'div',
  'tr',
  'pre',
  'title',
  'summary',
  'dt',
  'dd',
]);

/** The Rust standard library's COPYRIGHT-library.html as plain text, for THIRD-PARTY-NOTICES.txt. */
export function rustNoticeText(html: string): string {
  // one pass over the markup: a tag is dropped (a line break where it ends a block), and everything inside <style> or
  // <script> with it; the text between tags is kept
  let plain = '';
  let skipping = '';
  for (let at = 0; at < html.length;) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      plain += skipping ? '' : html.slice(at);
      break;
    }
    plain += skipping ? '' : html.slice(at, open);
    const close = html.indexOf('>', open);
    const tag = (close < 0 ? html.slice(open + 1) : html.slice(open + 1, close))
      .trim()
      .toLowerCase();
    const name = /^\/?([a-z0-9]+)/.exec(tag)?.[1] ?? '';
    if (skipping) {
      skipping = tag === `/${skipping}` ? '' : skipping;
    } else if (!tag.startsWith('/') && SKIPPED_TAGS.has(name)) {
      skipping = name;
    } else if (name === 'br' || (tag.startsWith('/') && BLOCK_TAGS.has(name))) {
      plain += '\n';
    }
    at = close < 0 ? html.length : close + 1;
  }
  const text = plain
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, HEX)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${text}\n`;
}

/**
 * Keeps what the inventory found: each crates.io crate's .crate under the cache's sources/crates/ (crates.io never
 * changes a published version, so one copy serves every library and build), each linked crate's licence files and
 * the standard library's notices beside the library's own (legal/<library>/), for THIRD-PARTY-NOTICES.txt.
 */
export function keepCrates(
  inventory: CrateInventory,
  a: { library: string; sources: string; depsDir: string },
): { crates: CrateRecord[]; rust: RustRecord } {
  const legal = join(a.depsDir, FFB_SHARE, 'legal', a.library);
  const crates = inventory.crates.map((c): CrateRecord => {
    const record: CrateRecord = {
      name: c.name,
      version: c.version,
      ...(c.license ? { license: c.license } : {}),
      source: c.source,
      linked: c.linked,
      texts: c.licenceFiles.map((f) => f.name),
      ...(c.standard ? { standard: c.standard, authors: c.authors ?? [] } : {}),
    };
    if (c.crateFile) {
      record.file = `crates/${c.name}-${c.version}.crate`;
      keepSource(a.sources, record.file, c.crateFile);
      record.sha256 = c.sha256!;
    }
    for (const f of c.licenceFiles) {
      const to = join(legal, 'crates', `${c.name}-${c.version}`, f.name);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(f.from, to);
    }
    return record;
  });
  mkdirSync(join(legal, 'rust'), { recursive: true });
  writeFileSync(
    join(legal, 'rust', 'COPYRIGHT-library.txt'),
    rustNoticeText(readFileSync(inventory.rustNotices, 'utf8')),
  );
  return { crates, rust: { version: inventory.rustVersion, texts: ['COPYRIGHT-library.txt'] } };
}
