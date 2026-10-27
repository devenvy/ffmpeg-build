import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeBuildSbom } from '../src/build/sbom.ts';

import type { SourceRecord } from '../src/build/fetch.ts';
import type { createSpdx } from '../src/sbom.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const source = (name: string): SourceRecord => ({
  name,
  version: '1.2.3',
  origin: `https://example.org/${name}-1.2.3.tar.gz`,
  file: `${name}/${name}-1.2.3.tar.gz`,
  sha256: hash(name),
});
const ffmpeg: SourceRecord = {
  ...source('ffmpeg'),
  version: '9.0.2',
  file: 'ffmpeg/ffmpeg-9.0.2.tar.xz',
  origin: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
};

function fixture(): Parameters<typeof writeBuildSbom>[0] {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-sbom-'));
  roots.push(root);
  const out = join(root, 'out');
  const work = join(root, 'work');
  const depsDir = join(root, 'deps');
  mkdirSync(out);
  mkdirSync(join(work, 'stage/run'), { recursive: true });
  mkdirSync(depsDir);
  const name = 'ffmpeg-9.0.2-linux-x64-lgplv3';
  writeFileSync(join(out, `${name}.tar.gz`), 'runtime archive fixture bytes');
  writeFileSync(join(out, `${name}-dev.tar.gz`), 'development archive fixture bytes');
  return {
    out,
    work,
    depsDir,
    buildPlan: {
      name,
      target: 'linux-x64-lgplv3',
      platform: 'linux-x64',
      engine: '0.0.19',
      toolchain: 'observed-toolchain-identity',
      license: 'lgplv3',
      patches: [],
      ships: [],
      libraries: [
        { name: 'sample', version: '1.2.3', license: 'MIT', linkage: 'static', licenseFiles: [] },
      ],
    },
  };
}

function read(context: ReturnType<typeof fixture>): ReturnType<typeof createSpdx> {
  const path = join(context.out, `${context.buildPlan.name}.spdx.json`);
  if (process.env['FFB_SPDX_VALIDATOR']) {
    execFileSync(process.env['FFB_SPDX_VALIDATOR'], ['-i', path], { stdio: 'pipe' });
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof createSpdx>;
}

describe('observed build SBOM', () => {
  it('records configured linkage as build context without asserting binary static-link evidence', () => {
    const context = fixture();
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    const document = read(context);
    const sample = document.packages.find((item) => item.name === 'sample')!;
    expect(sample.checksums).toEqual([{ algorithm: 'SHA256', checksumValue: hash('sample') }]);
    expect(document.relationships.some((item) => item.relationshipType === 'STATIC_LINK')).toBe(
      false,
    );
    expect(document.relationships).toContainEqual(
      expect.objectContaining({
        relatedSpdxElement: sample.SPDXID,
        relationshipType: 'DEPENDS_ON',
        comment: expect.stringContaining('selected linkage: static'),
      }),
    );
  });

  it('defines a custom reference from its identified licence file and preserves unresolved declarations honestly', () => {
    const context = fixture();
    const library = context.buildPlan.libraries[0]!;
    library.license = 'MIT AND LicenseRef-pffft';
    library.licenseFiles = [{ path: 'LICENSE-pffft' }, { path: 'COPYING' }];
    const legal = join(context.depsDir, 'share/ffmpeg-build/legal/sample');
    mkdirSync(legal, { recursive: true });
    writeFileSync(join(legal, 'LICENSE-pffft'), 'Actual pffft fixture licence.');
    writeFileSync(join(legal, 'COPYING'), 'Another upstream licence.');
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    let document = read(context);
    expect(document.packages.find((item) => item.name === 'sample')!.licenseDeclared).toMatch(
      /^MIT AND LicenseRef-pffft-/,
    );
    expect(document.hasExtractedLicensingInfos).toEqual([
      expect.objectContaining({ extractedText: 'Actual pffft fixture licence.' }),
    ]);
    library.license = 'Apache-2.0 AND LicenseRef-Not-Separately-Identified';
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    document = read(context);
    const sample = document.packages.find((item) => item.name === 'sample')!;
    expect(sample.licenseDeclared).toBe('NOASSERTION');
    expect(sample.licenseComments).toContain(library.license);
    expect(document.hasExtractedLicensingInfos).toBeUndefined();
  });

  it('distinguishes linked Cargo dependencies from source-only records and captured tools with unknown metadata', () => {
    const context = fixture();
    const record = source('sample');
    record.crates = [
      {
        name: 'serde',
        version: '1.0.228',
        source: 'crates.io',
        linked: true,
        license: 'MIT OR Apache-2.0',
        sha256: hash('serde'),
        texts: [],
      },
      { name: 'source-only', version: '2.0.0', source: 'crates.io', linked: false, texts: [] },
    ];
    record.rust = { version: '1.90.0', texts: [] };
    record.supplementalSources = [
      {
        kind: 'binary-build-tool',
        repository: 'captured-generator',
        filename: 'generator.zip',
        origin: 'https://example.org/generator.zip',
        sha256: hash('generator'),
        file: 'supplemental/generator',
      },
    ];
    writeBuildSbom(context, ffmpeg, [record]);
    const document = read(context);
    const serde = document.packages.find((item) => item.name === 'serde')!;
    const sourceOnly = document.packages.find((item) => item.name === 'source-only')!;
    const generator = document.packages.find((item) => item.name === 'captured-generator')!;
    expect(serde.externalRefs[0]!.referenceLocator).toBe('pkg:cargo/serde@1.0.228');
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ relatedSpdxElement: serde.SPDXID, relationshipType: 'DEPENDS_ON' }),
    );
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ relatedSpdxElement: sourceOnly.SPDXID, relationshipType: 'OTHER' }),
    );
    expect(generator).not.toHaveProperty('versionInfo');
    expect(generator.licenseDeclared).toBe('NOASSERTION');
    expect(document.relationships).toContainEqual(
      expect.objectContaining({
        spdxElementId: generator.SPDXID,
        relationshipType: 'BUILD_DEPENDENCY_OF',
      }),
    );
  });

  it('normalizes gated Cargo declarations and preserves ungated licence metadata without asserting validity', () => {
    const context = fixture();
    const record = source('sample');
    record.crates = [
      {
        name: 'legacy-license',
        version: '1.0',
        source: 'crates.io',
        linked: true,
        license: 'MIT/Apache-2.0',
        texts: [],
      },
      {
        name: 'source-metadata',
        version: '2.0',
        source: 'crates.io',
        linked: false,
        license: 'BSD',
        texts: [],
      },
    ];
    writeBuildSbom(context, ffmpeg, [record]);
    const document = read(context);
    const linked = document.packages.find((item) => item.name === 'legacy-license')!;
    expect(linked.licenseDeclared).toBe('MIT OR Apache-2.0');
    expect(linked.licenseComments).toContain('MIT/Apache-2.0');
    const metadata = document.packages.find((item) => item.name === 'source-metadata')!;
    expect(metadata.licenseDeclared).toBe('NOASSERTION');
    expect(metadata.licenseComments).toContain('BSD');
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ relatedSpdxElement: metadata.SPDXID, relationshipType: 'OTHER' }),
    );
  });

  it('retains the gated declaration when the same immutable crate is first observed as source-only', () => {
    const inventory = (linkedFirst: boolean) => {
      const context = fixture();
      const entries = linkedFirst
        ? ['linked-owner', 'source-owner']
        : ['source-owner', 'linked-owner'];
      const template = context.buildPlan.libraries[0]!;
      context.buildPlan.libraries = entries.map((name) => ({ ...template, name }));
      const records = entries.map((name) => ({
        ...source(name),
        crates: [
          {
            name: 'same-crate',
            version: '3.0',
            source: 'crates.io' as const,
            sha256: hash('immutable-crate'),
            linked: name === 'linked-owner',
            license: 'MIT/Apache-2.0',
            texts: [],
          },
        ],
      }));
      writeBuildSbom(context, ffmpeg, records);
      return read(context).packages.find((item) => item.name === 'same-crate')!;
    };
    const sourceFirst = inventory(false);
    expect(sourceFirst.licenseDeclared).toBe('MIT OR Apache-2.0');
    expect(sourceFirst).toEqual(inventory(true));
  });

  it('rejects contradictory gated declarations for the same immutable crate', () => {
    const context = fixture();
    const template = context.buildPlan.libraries[0]!;
    context.buildPlan.libraries = ['first', 'second'].map((name) => ({ ...template, name }));
    const records = context.buildPlan.libraries.map((library) => ({
      ...source(library.name),
      crates: [
        {
          name: 'same-crate',
          version: '3.0',
          source: 'crates.io' as const,
          sha256: hash('immutable-crate'),
          linked: true,
          license: library.name === 'first' ? 'MIT' : 'ISC',
          texts: [],
        },
      ],
    }));
    expect(() => writeBuildSbom(context, ffmpeg, records)).toThrow(/conflicting.*licen[cs]e/);
  });

  it('records user-owned proprietary patch text without treating its tree hash as an archive hash', () => {
    const context = fixture();
    context.buildPlan.license = 'nonfree';
    context.buildPlan.patches = [
      {
        name: 'owned-extension',
        license: 'proprietary',
        sha256: hash('patch-tree'),
        files: [],
        licenses: [{ path: 'LICENSE', text: 'Actual proprietary fixture licence.' }],
        configure: [],
      },
    ];
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    const document = read(context);
    const patch = document.packages.find((item) => item.name === 'owned-extension')!;
    expect(patch.licenseDeclared).toMatch(/^LicenseRef-User-Patch-/);
    expect(patch.checksums).toBeUndefined();
    expect(patch.sourceInfo).toContain(hash('patch-tree'));
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ spdxElementId: patch.SPDXID, relationshipType: 'PATCH_FOR' }),
    );
    expect(document.hasExtractedLicensingInfos).toContainEqual(
      expect.objectContaining({ extractedText: 'Actual proprietary fixture licence.' }),
    );
  });

  it('uses runtime containment only for an observed staged toolchain file', () => {
    const context = fixture();
    context.buildPlan.ships = [{ file: 'libtoolchain.so.1', license: 'MIT', notice: 'NOTICE' }];
    writeFileSync(join(context.work, 'stage/run/libtoolchain.so.1'), 'observed runtime');
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    const document = read(context);
    const runtime = document.packages.find((item) => item.name === 'libtoolchain.so.1')!;
    expect(runtime).not.toHaveProperty('versionInfo');
    expect(runtime.checksums).toEqual([
      { algorithm: 'SHA256', checksumValue: hash('observed runtime') },
    ]);
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ relatedSpdxElement: runtime.SPDXID, relationshipType: 'CONTAINS' }),
    );
  });

  it('hashes the actual nested Android runtime file and records its archive path', () => {
    const context = fixture();
    context.buildPlan.platform = 'android-arm64';
    context.buildPlan.ships = [
      {
        file: '/ndk/lib/libc++_shared.so',
        license: 'Apache-2.0 WITH LLVM-exception',
        notice: 'NOTICE',
      },
    ];
    const directory = join(context.work, 'stage/run/lib/arm64-v8a');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'libc++_shared.so'), 'Android runtime bytes');
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    const document = read(context);
    const runtime = document.packages.find((item) => item.name === 'libc++_shared.so')!;
    expect(runtime.checksums).toEqual([
      { algorithm: 'SHA256', checksumValue: hash('Android runtime bytes') },
    ]);
    expect(runtime.sourceInfo).toContain('lib/arm64-v8a/libc++_shared.so');
    expect(document.relationships).toContainEqual(
      expect.objectContaining({ relatedSpdxElement: runtime.SPDXID, relationshipType: 'CONTAINS' }),
    );
  });

  it('rejects unobserved dependencies or mismatched source versions before emitting a document', () => {
    const context = fixture();
    context.buildPlan.libraries[0]!.dependencies = ['not-observed'];
    expect(() => writeBuildSbom(context, ffmpeg, [source('sample')])).toThrow(/not-observed/);
    expect(existsSync(join(context.out, `${context.buildPlan.name}.spdx.json`))).toBe(false);
    context.buildPlan.libraries[0]!.dependencies = [];
    expect(() =>
      writeBuildSbom(context, ffmpeg, [{ ...source('sample'), version: 'wrong-version' }]),
    ).toThrow(/observed source version/);
  });
});
