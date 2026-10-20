// A fake cargo for recipe tests: a registry under the harness (crates unpacked in registry/src, their .crate files in
// registry/cache), a Cargo.lock in the source pinning their checksums, a Rust sysroot with its standard library's
// notices, and the answers rustc and cargo give the engine's crate inventory.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Harness } from './recipe-harness.ts';

export interface FakeCrate {
  name: string;
  version: string;
  license?: string;
  /** Files in the crate's root (its licence files among them). */
  files?: Record<string, string>;
  /** Linked into the library (else only compiled for the build: a build script's or procedural macro's). */
  linked?: boolean;
  /** A path dependency: its folder in the source. */
  path?: string;
  /** A git dependency. */
  git?: boolean;
  licenseFile?: string;
  authors?: string[];
  /** Cargo.lock's checksum, when it isn't the .crate's. */
  checksum?: string;
  /** In Cargo.lock only: cargo metadata doesn't resolve it (an optional dependency of a feature the build leaves off). */
  unresolved?: boolean;
}

const INDEX = 'index.crates.io-1949cf8c6b5b557f';
const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';
const FAKE_HOST = 'x86_64-unknown-linux-gnu';
const RUST_COPYRIGHT =
  '<html><body><h1>Copyright notices for The Rust Standard Library</h1><p>Apache-2.0 OR MIT &amp; more</p></body></html>';

export const crateBytes = (c: FakeCrate): string => `crate ${c.name}-${c.version}`;
export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export function fakeCargo(
  h: Harness,
  root: { name: string; version: string; license: string },
  crates: readonly FakeCrate[],
): { home: string; sysroot: string } {
  const home = join(h.root, 'cargo-home');
  const sysroot = join(h.root, 'sysroot');
  h.write(join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html'), RUST_COPYRIGHT);
  const lock = [
    'version = 4',
    '',
    '[[package]]',
    `name = "${root.name}"`,
    `version = "${root.version}"`,
  ];
  const packages: object[] = [
    {
      name: root.name,
      version: root.version,
      id: `path+file://${h.src}#${root.version}`,
      license: root.license,
      license_file: null,
      source: null,
      authors: [],
      manifest_path: join(h.src, 'Cargo.toml'),
    },
  ];
  for (const c of crates) {
    const dir = c.path
      ? join(h.src, c.path)
      : join(home, 'registry', 'src', INDEX, `${c.name}-${c.version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "${c.name}"\n`);
    for (const [file, text] of Object.entries(c.files ?? {})) {
      h.write(join(dir, file), text);
    }
    let source: string | null = null;
    if (c.git) {
      source = `git+https://example.com/${c.name}#0123456789abcdef`;
    } else if (!c.path) {
      source = REGISTRY;
      h.write(
        join(home, 'registry', 'cache', INDEX, `${c.name}-${c.version}.crate`),
        crateBytes(c),
      );
    }
    lock.push('', '[[package]]', `name = "${c.name}"`, `version = "${c.version}"`);
    if (source) {
      lock.push(`source = "${source}"`);
    }
    if (source === REGISTRY) {
      lock.push(`checksum = "${c.checksum ?? sha(crateBytes(c))}"`);
    }
    packages.push(
      ...(c.unresolved
        ? []
        : [
            {
              name: c.name,
              version: c.version,
              id: `${source ?? `path+file://${dir}`}#${c.name}@${c.version}`,
              license: c.license ?? null,
              license_file: c.licenseFile ?? null,
              source,
              authors: c.authors ?? [],
              manifest_path: join(dir, 'Cargo.toml'),
            },
          ]),
    );
  }
  h.write(join(h.src, 'Cargo.lock'), `${lock.join('\n')}\n`);
  const line = (c: { name: string; version: string; license?: string; path?: string }, at = '') =>
    `${c.name} v${c.version}${at}|${c.license ?? ''}`;
  const tree = (linkedOnly: boolean) =>
    [
      line(root, ` (${h.src})`),
      ...crates
        .filter((c) => !c.unresolved && (!linkedOnly || c.linked !== false))
        .map((c) => {
          const proc = c.linked === false ? ' (proc-macro)' : '';
          return line(c, c.path ? ` (${join(h.src, c.path)})` : proc);
        }),
      // a crate reached twice is printed again, marked (*)
      ...(crates[0] ? [`${line(crates[0])} (*)`] : []),
    ].join('\n');
  const before = h.onRun;
  h.onRun = (call) => {
    const args = call.args.join(' ');
    if (call.command === 'rustc' && args === '-vV') {
      return `rustc 1.98.1 (48a229cea 2026-09-01)\nbinary: rustc\nhost: ${FAKE_HOST}\nrelease: 1.98.1\n`;
    }
    if (call.command === 'rustc' && args === '--print sysroot') {
      return `${sysroot}\n`;
    }
    if (call.command === 'cargo' && call.args[0] === 'metadata') {
      return JSON.stringify({ packages, workspace_members: [packages[0]] });
    }
    if (call.command === 'cargo' && call.args[0] === 'tree') {
      return `${tree(args.includes('normal,no-proc-macro'))}\n`;
    }
    if (call.command === 'cargo' && call.args[0] === 'fetch') {
      return '';
    }
    return before(call);
  };
  return { home, sysroot };
}
