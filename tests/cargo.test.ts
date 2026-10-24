import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { crateBytes, fakeCargo, type FakeCrate, sha } from './cargo-fake.ts';
import { commands, harness, type Harness } from './recipe-harness.ts';
import {
  crateLicenseProblems,
  discoverCrates,
  keepCrates,
  rustNoticeText,
  spdxBranches,
} from '../src/build/cargo.ts';
import { runRecipe } from '../src/build/library.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { recipeSchema } from '../src/schema/engine.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

const table = loadEngineData(packageRoot).licenses;
const x86 = 'x86_64-unknown-linux-gnu';

let made: Harness[] = [];
afterEach(() => {
  for (const h of made) {
    rmSync(h.root, { recursive: true, force: true });
  }
  made = [];
});
function fake(platform = 'linux-x64'): Harness {
  const h = harness(platform);
  made.push(h);
  return h;
}

const ROOT = { name: 'sample', version: '1.0.0', license: 'BSD-2-Clause' };
const MIT = { 'LICENSE-MIT': 'MIT License\nCopyright (c) the libc authors\n' };
const APACHE = { 'LICENSE-APACHE': 'Apache License\nVersion 2.0\n' };
const CRATES: FakeCrate[] = [
  { name: 'libc', version: '0.2.172', license: 'MIT OR Apache-2.0', files: { ...MIT, ...APACHE } },
  // old-style "/" and a COPYRIGHT file kept as a text too
  {
    name: 'bitstream-io',
    version: '4.2.0',
    license: 'MIT/Apache-2.0',
    files: {
      'LICENSE-APACHE': 'Apache License\nVersion 2.0\n',
      COPYRIGHT: 'by them\n',
      'src/lib.rs': '',
    },
  },
  // a procedural macro: compiled for the build, never linked
  { name: 'paste', version: '1.0.15', license: 'GPL-3.0-only', linked: false, files: MIT },
  // a path dependency inside the source
  {
    name: 'ivf',
    version: '0.1.4',
    license: 'BSD-2-Clause',
    path: 'ivf',
    files: { LICENSE: 'bsd\n' },
  },
  // no licence file at all: the standard text, once reviewed
  { name: 'av-metrics', version: '0.9.1', license: 'MIT', authors: ['Josh Holmer'] },
  // in Cargo.lock for a feature the build leaves off: cargo metadata doesn't resolve it, yet cargo vendor keeps it
  { name: 'aom-sys', version: '0.3.3', unresolved: true },
];
const spec = (more: Partial<Parameters<typeof discoverCrates>[0]> = {}) => ({
  library: 'sample',
  target: 'x86_64-pc-windows-gnu',
  package: 'sample',
  features: ['capi'],
  standardTexts: ['av-metrics'],
  textIds: ['MIT', 'Apache-2.0', 'MPL-2.0'],
  table,
  ...more,
});

describe('SPDX expressions of crates', () => {
  it('reads OR, AND, brackets, WITH and the old "/" as the alternatives that satisfy them', () => {
    expect(spdxBranches('MIT')).toEqual([['MIT']]);
    expect(spdxBranches('MIT/Apache-2.0')).toEqual([['MIT'], ['Apache-2.0']]);
    expect(spdxBranches('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual([
      ['MIT', 'Unicode-3.0'],
      ['Apache-2.0', 'Unicode-3.0'],
    ]);
    expect(spdxBranches('Apache-2.0 WITH LLVM-exception OR MIT')).toEqual([
      ['Apache-2.0 WITH LLVM-exception'],
      ['MIT'],
    ]);
    expect(() => spdxBranches('MIT OR')).toThrow('MIT OR');
  });
});

describe("the licence gate on a Rust library's crates", () => {
  const crate = (license: string) => ({ name: 'x', version: '1.0.0', license });
  it('takes crates whose licence the recipe names, and that every build the recipe allows may carry', () => {
    expect(
      crateLicenseProblems({
        library: 'rav1e',
        recipeLicense: 'BSD-2-Clause AND MIT AND Unicode-3.0',
        buildLicense: 'lgplv2',
        table,
        crates: [
          crate('MIT OR Apache-2.0'),
          crate('Unlicense OR MIT'),
          crate('(MIT OR Apache-2.0) AND Unicode-3.0'),
        ],
      }),
    ).toEqual([]);
  });
  it("refuses a crate whose licence the recipe's license: doesn't name", () => {
    expect(
      crateLicenseProblems({
        library: 'rav1e',
        recipeLicense: 'BSD-2-Clause',
        table,
        crates: [crate('MIT OR Apache-2.0')],
      }),
    ).toEqual([
      "x 1.0.0 is under MIT OR Apache-2.0, which rav1e's license: (BSD-2-Clause) doesn't name: add it to recipes/rav1e/recipe.yml's license:",
    ]);
  });
  it('refuses a crate the build licence may not carry, such as a GPL crate in an LGPL build', () => {
    expect(
      crateLicenseProblems({
        library: 'librsvg',
        recipeLicense: 'LGPL-2.1-or-later AND GPL-3.0-or-later',
        buildLicense: 'lgplv3',
        table,
        crates: [crate('GPL-3.0-or-later')],
      }),
    ).toEqual([
      'x 1.0.0 is under GPL-3.0-or-later, which a lgplv3 build may not carry (licenses.yml allows it in gplv3, nonfree)',
    ]);
  });
  it('refuses a crate that would make a recipe allowed in more builds than the crate is', () => {
    // MIT OR Apache-2.0 names Apache-2.0, but says the library goes into version 2 builds, where Apache-2.0 may not
    expect(
      crateLicenseProblems({
        library: 'y',
        recipeLicense: 'MIT OR Apache-2.0',
        table,
        crates: [crate('Apache-2.0')],
      }),
    ).toEqual([
      "x 1.0.0 is under Apache-2.0, which only lgplv3, gplv3, nonfree builds may carry, but y's license: (MIT OR Apache-2.0) allows lgplv2, lgplv3, gplv2, gplv3, nonfree: make it name Apache-2.0 with AND",
    ]);
  });
  it('refuses a licence licenses.yml has no entry for, and one it cannot read', () => {
    expect(
      crateLicenseProblems({
        library: 'z',
        recipeLicense: 'MIT AND Foo-1.0',
        table,
        crates: [crate('Foo-1.0'), crate('MIT AND')],
      }),
    ).toEqual([
      'x 1.0.0 is under Foo-1.0, which licenses.yml has no entry for (Foo-1.0): add one, saying which builds may carry it',
      "x 1.0.0 is under MIT AND, which isn't an SPDX expression the engine can read",
    ]);
  });
});

describe("a Rust library's crate inventory", () => {
  it('fetches every crate of Cargo.lock, then lists offline what is linked in for the target', async () => {
    const h = fake();
    fakeCargo(h, ROOT, CRATES);
    const found = await discoverCrates({ ...spec(), src: h.src, env: h.base });
    expect(commands(h)).toEqual([
      'rustc -vV',
      // all of them, as cargo vendor would: cargo-c reads every package's metadata, and the build is offline
      'cargo fetch --locked',
      'cargo metadata --format-version 1 --locked --offline',
      'cargo tree --locked --offline -p sample -F capi --target x86_64-pc-windows-gnu -e normal,no-proc-macro --prefix none --format {p}|{l}',
      'rustc --print sysroot',
    ]);
    expect(h.calls.every((c) => c.capture)).toBe(true);
    expect(found.root).toEqual(ROOT);
    expect(found.rustVersion).toBe('1.98.1');
    expect(
      found.crates.map((c) => [c.name, c.version, c.license, c.source, c.linked, c.sha256 ?? '']),
    ).toEqual([
      ['aom-sys', '0.3.3', undefined, 'crates.io', false, sha(crateBytes(CRATES[5]!))],
      ['av-metrics', '0.9.1', 'MIT', 'crates.io', true, sha(crateBytes(CRATES[4]!))],
      ['bitstream-io', '4.2.0', 'MIT/Apache-2.0', 'crates.io', true, sha(crateBytes(CRATES[1]!))],
      ['ivf', '0.1.4', 'BSD-2-Clause', 'path', true, ''],
      ['libc', '0.2.172', 'MIT OR Apache-2.0', 'crates.io', true, sha(crateBytes(CRATES[0]!))],
      ['paste', '1.0.15', 'GPL-3.0-only', 'crates.io', false, sha(crateBytes(CRATES[2]!))],
    ]);
    // and the unresolved one, kept as a source: its .crate, no licence (none is needed: it isn't in the library)
    expect(found.crates.find((c) => c.name === 'aom-sys')).toMatchObject({
      source: 'crates.io',
      linked: false,
      sha256: sha(crateBytes(CRATES[5]!)),
    });
    expect(found.crates.find((c) => c.name === 'aom-sys')!.license).toBeUndefined();
    const byName = new Map(found.crates.map((c) => [c.name, c]));
    expect(byName.get('libc')!.licenceFiles.map((f) => f.name)).toEqual([
      'LICENSE-APACHE',
      'LICENSE-MIT',
    ]);
    expect(byName.get('bitstream-io')!.licenceFiles.map((f) => f.name)).toEqual([
      'COPYRIGHT',
      'LICENSE-APACHE',
    ]);
    expect(byName.get('ivf')!.licenceFiles.map((f) => f.name)).toEqual(['LICENSE']);
    // no file: the standard MIT text, and the authors its Cargo.toml names
    expect(byName.get('av-metrics')).toMatchObject({
      standard: ['MIT'],
      authors: ['Josh Holmer'],
      licenceFiles: [],
    });
    expect(byName.get('libc')!.crateFile).toMatch(/libc-0\.2\.172\.crate$/);
  });

  it('refuses a crate with no licence file that no one has reviewed', async () => {
    const h = fake();
    fakeCargo(h, ROOT, CRATES);
    await expect(
      discoverCrates({ ...spec({ standardTexts: [] }), src: h.src, env: h.base }),
    ).rejects.toThrow(
      "sample: the crate av-metrics 0.9.1 (MIT) ships no licence file: check its source and, if the standard text of its licence covers it, add it to recipes/sample/recipe.yml's cargo: standard-texts:",
    );
  });

  it(".crate whose sha256 isn't Cargo.lock's is refused", async () => {
    const h = fake();
    fakeCargo(h, ROOT, [{ ...CRATES[0]!, checksum: 'a'.repeat(64) }]);
    await expect(discoverCrates({ ...spec(), src: h.src, env: h.base })).rejects.toThrow(
      `sample: libc 0.2.172's .crate has sha256 ${sha(crateBytes(CRATES[0]!))}, not the ${'a'.repeat(64)} Cargo.lock pins`,
    );
  });

  it('refuses a git dependency, whose source the engine does not keep', async () => {
    const h = fake();
    fakeCargo(h, ROOT, [
      { name: 'gitdep', version: '0.1.0', license: 'MIT', git: true, files: MIT },
    ]);
    await expect(discoverCrates({ ...spec(), src: h.src, env: h.base })).rejects.toThrow(
      'sample: gitdep 0.1.0 comes from git+https://example.com/gitdep#0123456789abcdef; only crates.io crates and path dependencies inside the source are kept',
    );
  });

  it('refuses a crate with a licence file but no SPDX licence', async () => {
    const h = fake();
    fakeCargo(h, ROOT, [
      { name: 'ring', version: '0.17.0', licenseFile: 'LICENSE', files: { LICENSE: 'x' } },
    ]);
    await expect(discoverCrates({ ...spec(), src: h.src, env: h.base })).rejects.toThrow(
      "sample: ring 0.17.0 names no SPDX licence (only its licence file LICENSE): licenses.yml can't say where it may go",
    );
  });

  it('keeps each .crate under sources/crates/ and copies the licence texts beside the library', async () => {
    const h = fake();
    fakeCargo(h, ROOT, CRATES);
    const found = await discoverCrates({ ...spec(), src: h.src, env: h.base });
    const sources = join(h.root, 'sources');
    const kept = keepCrates(found, { library: 'sample', sources, depsDir: h.deps });
    expect(kept.crates.find((c) => c.name === 'libc')).toEqual({
      name: 'libc',
      version: '0.2.172',
      license: 'MIT OR Apache-2.0',
      source: 'crates.io',
      file: 'crates/libc-0.2.172.crate',
      sha256: sha(crateBytes(CRATES[0]!)),
      linked: true,
      texts: ['LICENSE-APACHE', 'LICENSE-MIT'],
    });
    expect(kept.crates.find((c) => c.name === 'ivf')).toEqual({
      name: 'ivf',
      version: '0.1.4',
      license: 'BSD-2-Clause',
      source: 'path',
      linked: true,
      texts: ['LICENSE'],
    });
    expect(kept.crates.find((c) => c.name === 'av-metrics')).toMatchObject({
      standard: ['MIT'],
      authors: ['Josh Holmer'],
      texts: [],
    });
    expect(readFileSync(join(sources, 'crates', 'libc-0.2.172.crate'), 'utf8')).toBe(
      crateBytes(CRATES[0]!),
    );
    // a build-only crate's source is kept too; its licence texts aren't carried
    expect(existsSync(join(sources, 'crates', 'paste-1.0.15.crate'))).toBe(true);
    const legal = join(h.deps, 'share', 'ffmpeg-build', 'legal', 'sample');
    expect(h.files(legal)).toEqual([
      'crates/bitstream-io-4.2.0/COPYRIGHT',
      'crates/bitstream-io-4.2.0/LICENSE-APACHE',
      'crates/ivf-0.1.4/LICENSE',
      'crates/libc-0.2.172/LICENSE-APACHE',
      'crates/libc-0.2.172/LICENSE-MIT',
      'rust/COPYRIGHT-library.txt',
    ]);
    expect(kept.rust).toEqual({ version: '1.98.1', texts: ['COPYRIGHT-library.txt'] });
    expect(readFileSync(join(legal, 'rust', 'COPYRIGHT-library.txt'), 'utf8')).toBe(
      'Copyright notices for The Rust Standard Library\nApache-2.0 OR MIT & more\n',
    );
  });

  it("reads the standard library's HTML notices as text", () => {
    expect(
      rustNoticeText(
        '<style>p{}</style><h2>A</h2><ul><li>x &#60;y&#62;</li><li>&quot;z&quot;</li></ul>\n\n\n\n<p>end</p>',
      ),
    ).toBe('A\nx <y>\n"z"\n\nend\n');
    // a script's text goes with it, nested markup or not; a tag never closed ends the text
    expect(rustNoticeText('<SCRIPT type="x">a <scr<script>ipt> b</script>kept<br/>line<p')).toBe(
      'kept\nline\n',
    );
  });
});

describe('a recipe with cargo:', () => {
  const parse = (build: unknown) =>
    recipeSchema.parse({
      name: 'sample',
      license: 'BSD-2-Clause AND MIT',
      'license-files': ['COPYING'],
      source: { git: 'https://example.com/sample' },
      versions: { 'git-tags': '^v(.*)$' },
      platforms: 'all',
      build,
    }).build;
  const planned = (h: Harness, buildLicense?: string) => {
    h.context.buildPlan = {
      ...h.context.buildPlan,
      ...(buildLicense ? { license: buildLicense } : {}),
      cargo: { licenses: Object.fromEntries(table), texts: { MIT: 'MIT License\n' } },
    } as typeof h.context.buildPlan;
  };

  it('takes its crate inventory after before:, checks it, and builds offline from then on', async () => {
    const h = fake();
    planned(h, 'lgplv2');
    fakeCargo(
      h,
      ROOT,
      CRATES.filter((c) => c.name !== 'av-metrics'),
    );
    const result = await runRecipe(
      h.context,
      {
        name: 'sample',
        version: '1.2.3',
        license: 'BSD-2-Clause AND MIT',
        build: parse({
          system: 'none',
          vars: { target: x86 },
          cargo: {
            target: '{target}',
            package: 'sample',
            features: ['capi'],
          },
          before: [['before']],
          steps: [['cargo', 'cinstall', '--locked']],
        }),
      },
      h.src,
    );
    const lines = commands(h);
    expect(lines[0]).toBe('before');
    expect(lines.at(-1)).toBe('cargo cinstall --locked [CARGO_NET_OFFLINE=true]');
    expect(lines.slice(1, -1).every((l) => l.startsWith('rustc') || l.startsWith('cargo'))).toBe(
      true,
    );
    expect(result.crates?.crates.map((c) => c.name)).toEqual([
      'aom-sys',
      'bitstream-io',
      'ivf',
      'libc',
      'paste',
    ]);
  });

  it('stops before building when a linked crate fails the licence gate', async () => {
    const h = fake();
    planned(h, 'lgplv2');
    fakeCargo(h, ROOT, [
      { name: 'gpl', version: '1.0.0', license: 'GPL-3.0-or-later', files: MIT },
    ]);
    await expect(
      runRecipe(
        h.context,
        {
          name: 'sample',
          version: '1.2.3',
          license: 'BSD-2-Clause AND MIT',
          build: parse({
            system: 'none',
            cargo: { target: x86, package: 'sample' },
            steps: [['cargo', 'cinstall']],
          }),
        },
        h.src,
      ),
    ).rejects.toThrow(
      "sample's Rust crates fail the licence check: gpl 1.0.0 is under GPL-3.0-or-later, which sample's license: (BSD-2-Clause AND MIT) doesn't name",
    );
    expect(commands(h)).not.toContain('cargo cinstall');
  });
});
