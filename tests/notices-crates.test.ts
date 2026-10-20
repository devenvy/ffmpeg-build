// THIRD-PARTY-NOTICES.txt for a build with a Rust library: the crates compiled into it, each licence text once, and
// the Rust standard library's notices once for the whole build.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkNotices, writeNotices } from '../src/build/notices.ts';

import type { CrateRecord } from '../src/build/cargo.ts';
import type { SourceRecord } from '../src/build/fetch.ts';
import type { BuildContext } from '../src/build/library.ts';

let root = '';
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const APACHE = 'Apache License\nVersion 2.0\n';
const crate = (c: Partial<CrateRecord> & { name: string }): CrateRecord => ({
  version: '1.0.0',
  license: 'MIT OR Apache-2.0',
  source: 'crates.io',
  file: `crates/${c.name}-1.0.0.crate`,
  sha256: 'a'.repeat(64),
  linked: true,
  texts: [],
  ...c,
});

function notices(): string {
  root = mkdtempSync(join(tmpdir(), 'ffb-notices-'));
  const deps = join(root, 'deps');
  const ffmpegDir = join(root, 'ffmpeg');
  put(join(ffmpegDir, 'config.h'), '#define FFMPEG_CONFIGURATION "--enable-librav1e"\n');
  put(join(ffmpegDir, 'LICENSE.md'), 'ffmpeg licence\n');
  put(join(ffmpegDir, 'CREDITS'), 'credits\n');
  const legal = join(deps, 'share', 'ffmpeg-build', 'legal');
  put(join(legal, 'rav1e', 'LICENSE'), 'rav1e bsd\n');
  put(join(legal, 'rav1e', 'crates', 'libc-1.0.0', 'LICENSE-MIT'), 'MIT: the libc authors\n');
  put(join(legal, 'rav1e', 'crates', 'libc-1.0.0', 'LICENSE-APACHE'), APACHE);
  put(join(legal, 'rav1e', 'crates', 'log-1.0.0', 'LICENSE-APACHE'), APACHE);
  put(join(legal, 'rav1e', 'rust', 'COPYRIGHT-library.txt'), 'Rust std notices\n');
  put(join(legal, 'librsvg', 'COPYING.LIB'), 'lgpl\n');
  put(join(legal, 'librsvg', 'rust', 'COPYRIGHT-library.txt'), 'Rust std notices\n');
  const plan = {
    notices: { header: 'FFmpeg 9.0.2 — notices\n', build: '', source: '', governing: [] },
    ffmpeg: { version: '9.0.2' },
    libraries: [
      {
        name: 'rav1e',
        version: '0.8.1',
        license: 'BSD-2-Clause AND MIT',
        licenseFiles: [{ path: 'LICENSE' }],
      },
      {
        name: 'librsvg',
        version: '2.63.3',
        license: 'LGPL-2.1-or-later AND MPL-2.0',
        licenseFiles: [{ path: 'COPYING.LIB' }],
      },
    ],
    patches: [],
    ships: [],
    cargo: {
      licenses: {},
      texts: { MIT: 'MIT License\n\nCopyright (c) <year> <copyright holders>\n' },
    },
  };
  const context = { buildPlan: plan, depsDir: deps, env: {} } as unknown as BuildContext;
  const source = { origin: 'https://x', file: 'x.tar.gz', sha256: 'b'.repeat(64) };
  const records: SourceRecord[] = [
    {
      name: 'rav1e',
      version: '0.8.1',
      ...source,
      crates: [
        crate({ name: 'libc', texts: ['LICENSE-APACHE', 'LICENSE-MIT'] }),
        crate({ name: 'log', texts: ['LICENSE-APACHE'] }),
        crate({ name: 'av-metrics', license: 'MIT', standard: ['MIT'], authors: ['Josh Holmer'] }),
        crate({ name: 'ivf', license: 'BSD-2-Clause', source: 'path', texts: [] }),
        crate({ name: 'paste', linked: false }),
      ],
      rust: { version: '1.98.1', texts: ['COPYRIGHT-library.txt'] },
    },
    {
      name: 'librsvg',
      version: '2.63.3',
      ...source,
      crates: [],
      rust: { version: '1.98.1', texts: ['COPYRIGHT-library.txt'] },
    },
  ];
  const out = join(root, 'THIRD-PARTY-NOTICES.txt');
  writeNotices(context, ffmpegDir, records, out);
  checkNotices(out, context);
  return readFileSync(out, 'utf8');
}

describe("THIRD-PARTY-NOTICES.txt for a Rust library's crates", () => {
  it('lists the crates linked into the library, under its entry', () => {
    const text = notices();
    expect(text).toContain(
      [
        '--- LICENSE ---',
        '',
        'rav1e bsd',
        '',
        'Rust crates compiled into rav1e (from its Cargo.lock, for this platform; each crates.io crate is in the sources',
        'archive as crates.io serves it, under sources/crates/):',
        '',
        '  av-metrics 1.0.0 (MIT)',
        '  ivf 1.0.0 (BSD-2-Clause; part of the rav1e source)',
        '  libc 1.0.0 (MIT OR Apache-2.0)',
        '  log 1.0.0 (MIT OR Apache-2.0)',
        '',
        "Rust's standard library (Rust 1.98.1) is linked in too: its notices are under RUST STANDARD LIBRARY below.",
        '',
      ].join('\n'),
    );
    // a crate only compiled for the build (a build script's or procedural macro's) isn't in what ships
    expect(text).not.toContain('paste');
  });

  it('carries each licence text once, naming every crate it is for', () => {
    const text = notices();
    expect(text).toContain(
      `--- libc 1.0.0: LICENSE-APACHE; log 1.0.0: LICENSE-APACHE ---\n\n${APACHE}\n`,
    );
    expect(text).toContain('--- libc 1.0.0: LICENSE-MIT ---\n\nMIT: the libc authors\n');
    expect(text.split(APACHE)).toHaveLength(2);
  });

  it('gives a crate with no licence file the standard text, saying so', () => {
    expect(notices()).toContain(
      '--- av-metrics 1.0.0: the standard MIT text (the crate ships no licence file; its Cargo.toml names as authors: Josh Holmer) ---\n\nMIT License\n',
    );
  });

  it("carries the standard library's notices once, for every library that links it", () => {
    const text = notices();
    expect(text).toContain(
      "RUST STANDARD LIBRARY\n================================================================================\n\nRust 1.98.1's standard library, linked into librsvg and rav1e: its notices as the Rust toolchain ships them\n(COPYRIGHT-library), the licences of its own code and of every crate it is built from.\n\n--- COPYRIGHT-library (Rust 1.98.1) ---\n\nRust std notices\n",
    );
    expect(text.split('Rust std notices')).toHaveLength(2);
  });
});
