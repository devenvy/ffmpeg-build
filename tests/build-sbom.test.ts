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
    context.buildPlan.ships = [{ file: 'libtoolchain.so.1', license: 'MIT', notice: ['NOTICE'] }];
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
        notice: ['NOTICE'],
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

  it('records a toolchain archive the configured link named, with that evidence, and no file it is not', () => {
    const context = fixture();
    context.buildPlan.platform = 'linux-musl-x64';
    const libstdcxx = {
      file: 'libstdc++',
      license: 'GPL-3.0-or-later WITH GCC-exception-3.1',
      notice: ['license-texts/GCC-exception-3.1.txt'],
      linked: ['libstdc++.a'],
    };
    const libgcc = { ...libstdcxx, file: 'libgcc', linked: ['-static-libgcc'], compiler: 'gcc' };
    context.buildPlan.ships = [libstdcxx, libgcc];
    // a staged file of the same name is not what a linked: entry is about
    writeFileSync(join(context.work, 'stage/run/libstdc++'), 'unrelated');
    writeBuildSbom(
      context,
      ffmpeg,
      [source('sample')],
      [
        {
          ...libstdcxx,
          evidence: ['libstdc++.a (EXTRALIBS-avcodec)'],
          compilerIdent: 'gcc 15.2.0 (Alpine 15.2.0)',
        },
      ],
    );
    const document = read(context);
    const runtime = document.packages.find((item) => item.name === 'libstdc++')!;
    expect(runtime).toMatchObject({
      licenseDeclared: 'GPL-3.0-or-later WITH GCC-exception-3.1',
      primaryPackagePurpose: 'LIBRARY',
    });
    expect(runtime).not.toHaveProperty('versionInfo');
    expect(runtime).not.toHaveProperty('checksums');
    expect(runtime.sourceInfo).toContain('libstdc++.a (EXTRALIBS-avcodec)');
    expect(runtime.sourceInfo).toContain('gcc 15.2.0 (Alpine 15.2.0)');
    expect(runtime.sourceInfo).toContain('version was not recorded');
    const archives = document.packages.filter((item) => item.primaryPackagePurpose === 'ARCHIVE');
    for (const archive of archives) {
      expect(document.relationships).toContainEqual(
        expect.objectContaining({
          spdxElementId: archive.SPDXID,
          relatedSpdxElement: runtime.SPDXID,
          relationshipType: 'DEPENDS_ON',
          comment: expect.stringContaining('does not assert which were linked'),
        }),
      );
    }
    // libgcc's flag wasn't shown: not in the inventory
    expect(document.packages.some((item) => item.name === 'libgcc')).toBe(false);
    // without what the build has, a linked: entry is never assumed
    writeBuildSbom(context, ffmpeg, [source('sample')]);
    expect(read(context).packages.some((item) => item.name === 'libstdc++')).toBe(false);
  });

  it("gives a runtime released with its compiler that compiler's version, and says where it came from", () => {
    const context = fixture();
    const libgcc = {
      file: 'libgcc',
      license: 'GPL-3.0-or-later WITH GCC-exception-3.1',
      notice: ['license-texts/GCC-exception-3.1.txt'],
      linked: ['libgcc.a'],
    };
    const winpthread = {
      ...libgcc,
      file: 'libwinpthread',
      license: 'MIT',
      linked: ['libpthread.a'],
    };
    context.buildPlan.ships = [libgcc, winpthread];
    writeBuildSbom(
      context,
      ffmpeg,
      [source('sample')],
      [
        {
          ...libgcc,
          evidence: ['libgcc.a (gcc -shared -###)'],
          version: { value: '14.2.1', source: 'gcc -dumpfullversion' },
        },
        { ...winpthread, evidence: ['libpthread.a (gcc -shared -###)'] },
      ],
    );
    const document = read(context);
    const runtime = document.packages.find((item) => item.name === 'libgcc')!;
    expect(runtime.versionInfo).toBe('14.2.1');
    expect(runtime.sourceInfo).toContain("Version: the linking compiler's (gcc -dumpfullversion)");
    expect(runtime.externalRefs[0]!.referenceLocator).toBe('pkg:generic/libgcc@14.2.1');
    // a separately packaged runtime: linked on the driver's evidence, the same relationship, no version
    const pthread = document.packages.find((item) => item.name === 'libwinpthread')!;
    expect(pthread).not.toHaveProperty('versionInfo');
    expect(document.relationships).toContainEqual(
      expect.objectContaining({
        relatedSpdxElement: pthread.SPDXID,
        relationshipType: 'DEPENDS_ON',
        comment: expect.stringContaining('libpthread.a (gcc -shared -###)'),
      }),
    );
  });

  it("defines a runtime whose licence only its text states from the toolchain's own notice", () => {
    const context = fixture();
    context.buildPlan.platform = 'win-x64';
    const crt = {
      file: 'mingw-w64-crt',
      license: 'LicenseRef-mingw-w64-runtime',
      notice: ['/ucrt64/share/licenses/crt/COPYING.MinGW-w64-runtime.txt'],
      linked: ['dllcrt2.o', 'libmingwex.a'],
    };
    context.buildPlan.ships = [crt];
    const text = 'MinGW-w64 runtime licensing\n\nZope Public License (ZPL) Version 2.1 ...\n';
    writeBuildSbom(
      context,
      ffmpeg,
      [source('sample')],
      [
        {
          ...crt,
          evidence: ['dllcrt2.o (gcc -shared -###)', 'libmingwex.a (gcc -shared -###)'],
          read: [
            {
              path: '/ucrt64/share/licenses/crt/COPYING.MinGW-w64-runtime.txt',
              heading: 'COPYING.MinGW-w64-runtime.txt',
              text,
            },
          ],
        },
      ],
    );
    const document = read(context);
    const runtime = document.packages.find((item) => item.name === 'mingw-w64-crt')!;
    expect(runtime.licenseDeclared).toMatch(/^LicenseRef-mingw-w64-runtime-[0-9a-f]+$/);
    expect(document.hasExtractedLicensingInfos).toContainEqual(
      expect.objectContaining({ licenseId: runtime.licenseDeclared, extractedText: text }),
    );
  });

  it("lists what the shipped binaries load from the host, as the host's, from the runtime archive only", () => {
    const context = fixture();
    writeBuildSbom(
      context,
      ffmpeg,
      [source('sample')],
      [],
      [
        { name: 'libc.so.6', format: 'ELF', needers: ['ffmpeg', 'libavutil.so.61.1.102'] },
        {
          name: 'Universal C Runtime (api-ms-win-crt-*.dll)',
          format: 'PE',
          needers: ['avutil-61.dll'],
          members: ['api-ms-win-crt-heap-l1-1-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'],
        },
      ],
    );
    const document = read(context);
    const libc = document.packages.find((item) => item.name === 'libc.so.6')!;
    expect(libc).toMatchObject({
      primaryPackagePurpose: 'LIBRARY',
      licenseDeclared: 'NOASSERTION',
    });
    expect(libc).not.toHaveProperty('versionInfo');
    expect(libc.sourceInfo).toContain('Provided by the operating system at run time; not shipped');
    expect(libc.sourceInfo).toContain(
      'ffmpeg, libavutil.so.61.1.102 (ELF NEEDED entry or program interpreter)',
    );
    const ucrt = document.packages.find((item) => item.name.startsWith('Universal C Runtime'))!;
    expect(ucrt.sourceInfo).toContain(
      'api-ms-win-crt-heap-l1-1-0.dll, api-ms-win-crt-runtime-l1-1-0.dll',
    );
    const runtime = document.packages.find(
      (item) => item.name === `${context.buildPlan.name}.tar.gz`,
    )!;
    const onHost = document.relationships.filter((edge) => edge.relatedSpdxElement === libc.SPDXID);
    expect(onHost).toEqual([
      expect.objectContaining({
        spdxElementId: runtime.SPDXID,
        relationshipType: 'DEPENDS_ON',
        comment: expect.stringContaining('Runtime dependency on the host system'),
      }),
    ]);
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
