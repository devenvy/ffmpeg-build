import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeGitHub, fakeGitHub, tarGz } from './github-fake.ts';
import { fixtureEngineRoot } from './helpers.ts';
import { bundle } from '../src/bundle.ts';
import { type EngineData, loadEngineData } from '../src/engine-data.ts';
import { fetchRelease } from '../src/fetch.ts';
import { type FolderLock, formatFolderLock } from '../src/lockfile.ts';
import { parseManifest } from '../src/manifest.ts';
import { packageRoot, packageVersion } from '../src/paths.ts';
import { planReleases } from '../src/release.ts';
import {
  artifactName,
  type Folder,
  loadFolder,
  shipsSymbols,
  symbolsName,
} from '../src/targets.ts';
import { readTarGz } from '../src/untar.ts';

const fixture = loadEngineData(fixtureEngineRoot);
// and win-x64, whose builds come with their debug symbols
const data: EngineData = {
  ...fixture,
  platforms: new Map([
    ...fixture.platforms,
    ['win-x64', { ...fixture.platforms.get('linux-x64')!, setup: 'windows' }],
  ]),
};
const LOCK: FolderLock = {
  engine: '0.2.0',
  ffmpeg: { '9': '9.1.0' },
  libraries: { dav1d: '1.5.4', opus: '1.6.1', x265: '4.1' },
};
const FOLDER = [
  'targets:',
  '  linux-x64-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d, opus] }',
  '  linux-x64-gplv3:  { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d, x265] }',
  '',
].join('\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const ignore = (): void => undefined;

/** A folder with its targets "built" into dist: archives, sources.json and the kept sources, as the driver leaves them. */
function builtFolder(
  text = FOLDER,
  edit: (
    name: string,
    sources: { libraries: { name: string; version: string }[] },
    dist: string,
  ) => void = ignore,
  // files the folder holds besides its ffmpeg-build.yml and lock (a patch set)
  files: Record<string, string> = {},
): { dir: string; dist: string; folder: Folder } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-bundle-'));
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(LOCK));
  const r = loadFolder(dir);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  for (const rel of planReleases(r.folder, data, LOCK, packageRoot).releases) {
    for (const p of rel.targets) {
      const name = artifactName(p.target, p.facts.ffmpeg);
      writeFileSync(
        join(dist, `${name}.tar.gz`),
        tarGz([
          { name: 'bin/ffmpeg', data: name, mode: 0o755 },
          { name: 'THIRD-PARTY-NOTICES.txt', data: 'notices' },
        ]),
      );
      writeFileSync(
        join(dist, `${name}-dev.tar.gz`),
        tarGz([{ name: 'include/libavutil/avutil.h', data: 'h' }]),
      );
      if (shipsSymbols(p.target.platform)) {
        writeFileSync(
          join(dist, symbolsName(name)),
          tarGz([{ name: 'avfilter-11.dll', data: 'unstripped' }]),
        );
      }
      const kept = (file: string, content: string): string => {
        mkdirSync(join(dist, `${name}.sources`, file, '..'), { recursive: true });
        writeFileSync(join(dist, `${name}.sources`, file), content);
        return sha(Buffer.from(content));
      };
      const record = (n: string, v: string) => ({
        name: n,
        version: v,
        origin: `https://example.org/${n}-${v}.tar.gz`,
        file: `${n}/${n}-${v}.tar.gz`,
        sha256: kept(`${n}/${n}-${v}.tar.gz`, `${n} ${v} source`),
      });
      const sources = {
        artifact: name,
        target: p.target.name,
        platform: p.target.platform,
        license: p.target.license,
        release: null,
        ffmpeg: record('ffmpeg', p.facts.ffmpeg),
        libraries: Object.entries(p.facts.components).map(([n, v]) => ({
          ...record(n, v),
          cached: false,
        })),
        patches: p.facts.patches,
      };
      edit(name, sources, dist);
      writeFileSync(join(dist, `${name}.sources.json`), JSON.stringify(sources));
    }
  }
  return { dir, dist, folder: r.folder };
}

let gh: FakeGitHub;
beforeEach(async () => {
  gh = await fakeGitHub();
  delete process.env['GITHUB_REPOSITORY'];
});
afterEach(async () => gh.close());

describe('ffmpeg-build bundle', () => {
  it('writes the manifest, the sources archive, SHA256SUMS, the notes, and what to upload', async () => {
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, {
      tag: '9.1.0.0',
      dist,
      engineRoot: packageRoot,
      repo: 'o/r',
    });
    expect(r.assets).toEqual([
      'ffmpeg-9.1.0-linux-x64-lgplv3.tar.gz',
      'ffmpeg-9.1.0-linux-x64-lgplv3-dev.tar.gz',
      'ffmpeg-9.1.0-linux-x64-gplv3.tar.gz',
      'ffmpeg-9.1.0-linux-x64-gplv3-dev.tar.gz',
      'ffmpeg-9.1.0-sources.tar.gz',
      'manifest.yml',
      'SHA256SUMS',
    ]);
    expect(r.latest).toBe(true);
    const m = parseManifest(readFileSync(join(dist, 'manifest.yml'), 'utf8'));
    expect(m).toMatchObject({
      release: '9.1.0.0',
      ffmpeg: '9.1.0',
      build: '0',
      engine: packageVersion(),
    });
    const lg = m.targets.find((t) => t.name === 'linux-x64-lgplv3')!;
    expect(lg.components).toEqual({ dav1d: '1.5.4', opus: '1.6.1' });
    expect(lg.assets.runtime.sha256).toBe(sha(readFileSync(join(dist, lg.assets.runtime.name))));
    // every asset but SHA256SUMS itself, with its sha256
    const sums = readFileSync(join(dist, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(6);
    for (const line of sums) {
      const [hash, file] = line.split(/ {2}/);
      expect(sha(readFileSync(join(dist, file!))), file).toBe(hash);
    }
    // the sources: each kept source once, the build definition, the engine's files, and the index
    const names = readTarGz(readFileSync(join(dist, 'ffmpeg-9.1.0-sources.tar.gz'))).map(
      (e) => e.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'ffmpeg-9.1.0-sources/sources/ffmpeg/ffmpeg-9.1.0.tar.gz',
        'ffmpeg-9.1.0-sources/sources/dav1d/dav1d-1.5.4.tar.gz',
        'ffmpeg-9.1.0-sources/sources/x265/x265-4.1.tar.gz',
        'ffmpeg-9.1.0-sources/build/ffmpeg-build.yml',
        'ffmpeg-9.1.0-sources/build/ffmpeg.lock',
        'ffmpeg-9.1.0-sources/engine/src/build/toolchain.ts',
        'ffmpeg-9.1.0-sources/engine/recipes/dav1d/recipe.yml',
        'ffmpeg-9.1.0-sources/SOURCES.md',
      ]),
    );
    expect(names.filter((n) => n.endsWith('dav1d-1.5.4.tar.gz'))).toHaveLength(1); // shared by both targets, kept once
    expect(readFileSync(join(dist, 'release-notes.md'), 'utf8')).toContain(
      '| linux-x64-gplv3 | gplv3 | `ffmpeg-9.1.0-linux-x64-gplv3.tar.gz` |',
    );
    expect(JSON.parse(readFileSync(join(dist, 'bundle.json'), 'utf8'))).toEqual({
      tag: '9.1.0.0',
      assets: r.assets,
      latest: true,
    });
  });

  it("publishes a win-x64 build's debug symbols beside it: in SHA256SUMS, the manifest and the notes", async () => {
    const win =
      'targets:\n  win-x64-lgplv3: { platform: win-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n';
    const { dist, folder } = builtFolder(win);
    const r = await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot });
    expect(r.assets).toEqual([
      'ffmpeg-9.1.0-win-x64-lgplv3.tar.gz',
      'ffmpeg-9.1.0-win-x64-lgplv3-dev.tar.gz',
      'symbols-9.1.0-win-x64-lgplv3.tar.gz',
      'ffmpeg-9.1.0-sources.tar.gz',
      'manifest.yml',
      'SHA256SUMS',
    ]);
    const symbols = readFileSync(join(dist, 'symbols-9.1.0-win-x64-lgplv3.tar.gz'));
    expect(readFileSync(join(dist, 'SHA256SUMS'), 'utf8')).toContain(
      `${sha(symbols)}  symbols-9.1.0-win-x64-lgplv3.tar.gz`,
    );
    const m = parseManifest(readFileSync(join(dist, 'manifest.yml'), 'utf8'));
    expect(m.targets[0]!.assets.symbols).toEqual({
      name: 'symbols-9.1.0-win-x64-lgplv3.tar.gz',
      sha256: sha(symbols),
    });
    expect(readFileSync(join(dist, 'release-notes.md'), 'utf8')).toContain(
      'symbols: `symbols-9.1.0-win-x64-lgplv3.tar.gz`',
    );
    // a linux build has none, and its manifest entry says nothing of them
    const linux = builtFolder();
    await bundle(linux.folder, data, LOCK, {
      tag: '9.1.0.0',
      dist: linux.dist,
      engineRoot: packageRoot,
    });
    const lm = parseManifest(readFileSync(join(linux.dist, 'manifest.yml'), 'utf8'));
    expect(lm.targets[0]!.assets).not.toHaveProperty('symbols');
    // a win-x64 build without them isn't complete
    const { rmSync } = await import('node:fs');
    const missing = builtFolder(win);
    rmSync(join(missing.dist, 'symbols-9.1.0-win-x64-lgplv3.tar.gz'));
    await expect(
      bundle(missing.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: missing.dist,
        engineRoot: packageRoot,
      }),
    ).rejects.toThrow(
      `win-x64-lgplv3 isn't built in ${missing.dist}: symbols-9.1.0-win-x64-lgplv3.tar.gz missing`,
    );
  });

  it('gives a product exactly what was bundled: fetch reads the manifest and checks every archive', async () => {
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, {
      tag: '9.1.0.0',
      dist,
      engineRoot: packageRoot,
      repo: 'o/r',
    });
    gh.releases.push({
      tag: '9.1.0.0',
      files: Object.fromEntries(r.assets.map((a) => [a, readFileSync(join(dist, a))])),
    });
    const out = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-bundle-fetch-')), 'ffmpeg');
    await fetchRelease('o/r@9.1.0.0', { target: 'linux-x64-gplv3', dev: true }, out);
    expect(readFileSync(join(out, 'bin', 'ffmpeg'), 'utf8')).toBe('ffmpeg-9.1.0-linux-x64-gplv3');
    expect(existsSync(join(out, 'THIRD-PARTY-NOTICES.txt'))).toBe(true);
  });

  it('refuses a missing build, a kept source that changed, and a build from other versions than the lock', async () => {
    const missing = builtFolder();
    const { rmSync } = await import('node:fs');
    rmSync(join(missing.dist, 'ffmpeg-9.1.0-linux-x64-gplv3-dev.tar.gz'));
    await expect(
      bundle(missing.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: missing.dist,
        engineRoot: packageRoot,
      }),
    ).rejects.toThrow("linux-x64-gplv3 isn't built in");
    const tampered = builtFolder();
    writeFileSync(
      join(tampered.dist, 'ffmpeg-9.1.0-linux-x64-gplv3.sources', 'x265', 'x265-4.1.tar.gz'),
      'other',
    );
    await expect(
      bundle(tampered.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: tampered.dist,
        engineRoot: packageRoot,
      }),
    ).rejects.toThrow("doesn't match its record; build it again");
    const stale = builtFolder(FOLDER, (_n, s) => {
      s.libraries = s.libraries.map((l) => (l.name === 'dav1d' ? { ...l, version: '1.4.0' } : l));
    });
    await expect(
      bundle(stale.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: stale.dist,
        engineRoot: packageRoot,
      }),
    ).rejects.toThrow('was built from other versions than ffmpeg.lock says (dav1d 1.5.4)');
  });

  it("keeps both when two machines kept the same source as different bytes (another tar and gzip), each build's own", async () => {
    const { dist, folder } = builtFolder();
    const gpl = 'ffmpeg-9.1.0-linux-x64-gplv3';
    const json = JSON.parse(readFileSync(join(dist, `${gpl}.sources.json`), 'utf8')) as {
      libraries: { name: string; file: string; sha256: string }[];
    };
    const dav1d = json.libraries.find((l) => l.name === 'dav1d')!;
    writeFileSync(join(dist, `${gpl}.sources`, dav1d.file), 'the same commit, archived elsewhere');
    dav1d.sha256 = sha(Buffer.from('the same commit, archived elsewhere'));
    writeFileSync(join(dist, `${gpl}.sources.json`), JSON.stringify(json));
    await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot });
    const entries = readTarGz(readFileSync(join(dist, 'ffmpeg-9.1.0-sources.tar.gz')));
    const kept = entries
      .filter((e) => e.name.endsWith('dav1d-1.5.4.tar.gz'))
      .map((e) => [e.name, e.data.toString()]);
    expect(kept).toEqual([
      ['ffmpeg-9.1.0-sources/sources/dav1d/dav1d-1.5.4.tar.gz', 'dav1d 1.5.4 source'],
      [
        `ffmpeg-9.1.0-sources/sources/dav1d/${dav1d.sha256.slice(0, 12)}/dav1d-1.5.4.tar.gz`,
        'the same commit, archived elsewhere',
      ],
    ]);
    const index = entries.find((e) => e.name.endsWith('SOURCES.md'))!.data.toString();
    expect(index).toContain(
      `| sources/dav1d/${dav1d.sha256.slice(0, 12)}/dav1d-1.5.4.tar.gz | ${dav1d.sha256} |`,
    );
  });

  it("puts a Rust library's crates in the sources archive, once, and lists them in SOURCES.md", async () => {
    const crate = (n: string, v: string, linked = true) => ({
      name: n,
      version: v,
      license: 'MIT OR Apache-2.0',
      source: 'crates.io',
      file: `crates/${n}-${v}.crate`,
      sha256: sha(Buffer.from(`${n} crate`)),
      linked,
      texts: [],
    });
    const { dist, folder } = builtFolder(FOLDER, (name, s, out) => {
      const dav1d = s.libraries.find((l) => l.name === 'dav1d')! as Record<string, unknown>;
      dav1d['crates'] = [
        crate('libc', '0.2.172'),
        crate('paste', '1.0.15', false),
        {
          name: 'ivf',
          version: '0.1.4',
          license: 'BSD-2-Clause',
          source: 'path',
          linked: true,
          texts: [],
        },
      ];
      mkdirSync(join(out, `${name}.sources`, 'crates'), { recursive: true });
      for (const n of ['libc-0.2.172', 'paste-1.0.15']) {
        writeFileSync(
          join(out, `${name}.sources`, 'crates', `${n}.crate`),
          `${n.split('-')[0]!} crate`,
        );
      }
    });
    await bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot });
    const entries = readTarGz(readFileSync(join(dist, 'ffmpeg-9.1.0-sources.tar.gz')));
    expect(entries.filter((e) => e.name.includes('/sources/crates/')).map((e) => e.name)).toEqual([
      'ffmpeg-9.1.0-sources/sources/crates/libc-0.2.172.crate',
      'ffmpeg-9.1.0-sources/sources/crates/paste-1.0.15.crate',
    ]);
    const index = entries.find((e) => e.name.endsWith('SOURCES.md'))!.data.toString();
    expect(index).toContain(
      `| dav1d: crate libc | 0.2.172 | https://static.crates.io/crates/libc/libc-0.2.172.crate |  | sources/crates/libc-0.2.172.crate | ${sha(Buffer.from('libc crate'))} |`,
    );
    expect(index).toContain(
      `| dav1d: crate paste (not linked) | 1.0.15 | https://static.crates.io/crates/paste/paste-1.0.15.crate |  | sources/crates/paste-1.0.15.crate |`,
    );
    // a path dependency is part of its library's own source
    expect(index).not.toContain('crate ivf');
    expect(index).toContain('cargo vendor');
  });

  it('refuses a Rust library whose kept crate changed', async () => {
    const { dist, folder } = builtFolder(FOLDER, (name, s, out) => {
      const dav1d = s.libraries.find((l) => l.name === 'dav1d')! as Record<string, unknown>;
      dav1d['crates'] = [
        {
          name: 'libc',
          version: '0.2.172',
          license: 'MIT',
          source: 'crates.io',
          file: 'crates/libc-0.2.172.crate',
          sha256: 'a'.repeat(64),
          linked: true,
          texts: [],
        },
      ];
      mkdirSync(join(out, `${name}.sources`, 'crates'), { recursive: true });
      writeFileSync(join(out, `${name}.sources`, 'crates', 'libc-0.2.172.crate'), 'x');
    });
    await expect(
      bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot }),
    ).rejects.toThrow("crates/libc-0.2.172.crate doesn't match its record; build it again");
  });

  it('refuses a build made with other patches than the folder has now', async () => {
    const { dist, folder } = builtFolder(FOLDER, (_n, s) => {
      (s as unknown as { patches: unknown[] }).patches = [
        { name: 'acme', sha256: 'ab'.repeat(32) },
      ];
    });
    await expect(
      bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot }),
    ).rejects.toThrow('was built with other patches than the folder has now; build it again');
  });

  it('names the release a tag must match', async () => {
    const { dist, folder } = builtFolder();
    await expect(
      bundle(folder, data, LOCK, { tag: '9.0.2.1', dist, engineRoot: packageRoot }),
    ).rejects.toThrow('no release 9.0.2 in this folder (it has 9.1.0)');
  });

  it('never sends a nonfree build to a public repository, and to a private one freely', async () => {
    const nonfree =
      'targets:\n  studio: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d] }\n';
    const nowhere = builtFolder(nonfree);
    await expect(
      bundle(nowhere.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: nowhere.dist,
        engineRoot: packageRoot,
      }),
    ).rejects.toThrow("there's no repository to check is private");
    const pub = builtFolder(nonfree);
    await expect(
      bundle(pub.folder, data, LOCK, {
        tag: '9.1.0.0',
        dist: pub.dist,
        engineRoot: packageRoot,
        repo: 'o/r',
      }),
    ).rejects.toThrow(
      'studio is nonfree: internal use only, never published to a public repository (o/r is public)',
    );
    gh.private = true;
    const internal = builtFolder(nonfree);
    await bundle(internal.folder, data, LOCK, {
      tag: '9.1.0.0',
      dist: internal.dist,
      engineRoot: packageRoot,
      repo: 'o/r',
    });
    const m = parseManifest(readFileSync(join(internal.dist, 'manifest.yml'), 'utf8'));
    expect(m.targets[0]!.redistributable).toBe('false');
    expect(readFileSync(join(internal.dist, 'release-notes.md'), 'utf8')).toContain(
      '**Internal use only:**',
    );
  });

  it("keeps a release's sources archive to the patch sets its own targets apply: another group's stay out", async () => {
    gh.private = true;
    const text = [
      'targets:',
      '  linux-x64-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }',
      '  server: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d], patches: [patches/acme], release-group: server }',
      '',
    ].join('\n');
    const files = {
      'patches/acme/about.yml':
        'name: acme\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: 9\n',
      'patches/acme/LICENSE': 'all rights reserved\n',
      'patches/acme/9/0001-acme.patch': '--- /dev/null\n+++ b/A\n@@ -0,0 +1 @@\n+a\n',
    };
    const archived = async (tag: string, archive: string) => {
      const { dist, folder } = builtFolder(text, ignore, files);
      await bundle(folder, data, LOCK, { tag, dist, engineRoot: packageRoot, repo: 'o/r' });
      return readTarGz(readFileSync(join(dist, archive))).map((e) => e.name);
    };
    // the public LGPL release, whose sources go to anyone it is distributed to: no trace of the proprietary set
    const lgpl = await archived('9.1.0.0', 'ffmpeg-9.1.0-sources.tar.gz');
    expect(lgpl.filter((n) => n.includes('patches/acme'))).toEqual([]);
    // the internal release that applies it carries it
    const server = await archived('server-9.1.0.0', 'ffmpeg-9.1.0-server-sources.tar.gz');
    expect(server).toEqual(
      expect.arrayContaining([
        'ffmpeg-9.1.0-server-sources/build/patches/acme/about.yml',
        'ffmpeg-9.1.0-server-sources/build/patches/acme/9/0001-acme.patch',
      ]),
    );
  });

  it('stops when a component of the last release is gone, unless allowed', async () => {
    const { dist, folder } = builtFolder();
    const previous = gh.publish('9.1.0.0', [
      {
        name: 'linux-x64-lgplv3',
        platform: 'linux-x64',
        components: { dav1d: '1.5.4', opus: '1.6.1', zimg: '3.0' },
      },
    ]);
    await expect(
      bundle(folder, data, LOCK, { tag: '9.1.0.1', dist, engineRoot: packageRoot, previous }),
    ).rejects.toThrow('linux-x64-lgplv3: zimg was in 9.1.0.0 and is gone now');
    const allowed = builtFolder(
      FOLDER.replace('with: [dav1d, opus] }', 'with: [dav1d, opus], allow-removal: [zimg] }'),
    );
    await expect(
      bundle(allowed.folder, data, LOCK, {
        tag: '9.1.0.1',
        dist: allowed.dist,
        engineRoot: packageRoot,
        previous,
      }),
    ).resolves.toMatchObject({ tag: '9.1.0.1' });
  });

  it("judges a group's first release on a new major against its last release of the major before", async () => {
    gh.publish('8.1.3.4', [
      {
        name: 'linux-x64-lgplv3',
        platform: 'linux-x64',
        components: { dav1d: '1.5.4', opus: '1.6.1', zimg: '3.0' },
      },
    ]);
    const { dist, folder } = builtFolder();
    await expect(
      bundle(folder, data, LOCK, { tag: '9.1.0.0', dist, engineRoot: packageRoot, repo: 'o/r' }),
    ).rejects.toThrow('linux-x64-lgplv3: zimg was in 8.1.3.4 and is gone now');
  });

  it('is latest only with the highest FFmpeg of its group', async () => {
    gh.publish('9.2.0.0', [{ name: 'linux-x64-lgplv3', platform: 'linux-x64' }]);
    const { dist, folder } = builtFolder();
    const r = await bundle(folder, data, LOCK, {
      tag: '9.1.0.0',
      dist,
      engineRoot: packageRoot,
      repo: 'o/r',
      previous: undefined,
    });
    expect(r.latest).toBe(false);
  });
});
