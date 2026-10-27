import { describe, expect, it } from 'vitest';

import { createSpdx, type SpdxInput } from '../src/sbom.ts';

const sourceHash = 'a'.repeat(64);
const fixture = (): SpdxInput => ({
  name: 'ffmpeg-9.0.2-linux-x64-lgplv3',
  target: 'linux-x64-lgplv3',
  platform: 'linux-x64',
  engine: '0.0.19',
  created: '2026-10-27T00:00:00Z',
  describes: ['ffmpeg'],
  packages: [
    {
      key: 'ffmpeg',
      name: 'ffmpeg',
      version: '9.0.2',
      downloadLocation: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
      sha256: sourceHash,
      license: 'LGPL-3.0-or-later',
    },
    {
      key: 'zlib',
      name: 'zlib',
      version: '1.3.2',
      downloadLocation: 'https://example.org/zlib-1.3.2.tar.gz',
      sha256: 'b'.repeat(64),
      license: 'Zlib',
      sourceInfo:
        'Selected linkage: static. Resolved build input; archive contents were not analyzed.',
    },
    { key: 'generator', name: 'build-generator', version: '2.0', license: 'MIT' },
    {
      key: 'serde',
      name: 'serde',
      version: '1.0.228',
      purl: 'pkg:cargo/serde@1.0.228',
      license: 'MIT OR Apache-2.0',
    },
  ],
  relationships: [
    { from: 'ffmpeg', to: 'zlib', type: 'DEPENDS_ON' },
    { from: 'generator', to: 'ffmpeg', type: 'BUILD_DEPENDENCY_OF' },
    { from: 'zlib', to: 'serde', type: 'DEPENDS_ON' },
  ],
});

describe('standard build SBOM', () => {
  it('does not accept a machine-local path as a published download location', () => {
    for (const location of [
      'file:///tmp/source.tar.gz',
      'D:/private/source.tar.gz',
      '/tmp/source.tar.gz',
    ]) {
      const input = fixture();
      input.packages[0]!.downloadLocation = location;
      expect(() => createSpdx(input)).toThrow(/download location/i);
    }
  });

  it('uses the whole-second UTC timestamp accepted by standard SPDX tooling', () => {
    expect(
      createSpdx({ ...fixture(), created: '2026-10-27T00:00:00.123Z' }).creationInfo.created,
    ).toBe('2026-10-27T00:00:00Z');
  });

  it('writes SPDX 2.3 package identities, declared licences, hashes and dependency relationships', () => {
    const document = createSpdx(fixture());
    expect(document.spdxVersion).toBe('SPDX-2.3');
    expect(document.SPDXID).toBe('SPDXRef-DOCUMENT');
    expect(document.dataLicense).toBe('CC0-1.0');
    expect(document.creationInfo).toEqual({
      created: '2026-10-27T00:00:00Z',
      creators: ['Tool: ffmpeg-build-0.0.19'],
    });
    const ffmpeg = document.packages.find((item) => item.name === 'ffmpeg')!;
    const zlib = document.packages.find((item) => item.name === 'zlib')!;
    const generator = document.packages.find((item) => item.name === 'build-generator')!;
    const serde = document.packages.find((item) => item.name === 'serde')!;
    expect(ffmpeg.versionInfo).toBe('9.0.2');
    expect(ffmpeg.checksums).toEqual([{ algorithm: 'SHA256', checksumValue: sourceHash }]);
    expect(ffmpeg.licenseDeclared).toBe('LGPL-3.0-or-later');
    expect(ffmpeg.licenseConcluded).toBe('NOASSERTION');
    expect(ffmpeg.filesAnalyzed).toBe(false);
    expect(zlib.sourceInfo).toContain('Selected linkage: static');
    expect(serde.externalRefs).toContainEqual({
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: 'pkg:cargo/serde@1.0.228',
    });
    expect(document.relationships).toEqual(
      expect.arrayContaining([
        {
          spdxElementId: 'SPDXRef-DOCUMENT',
          relationshipType: 'DESCRIBES',
          relatedSpdxElement: ffmpeg.SPDXID,
        },
        {
          spdxElementId: ffmpeg.SPDXID,
          relationshipType: 'DEPENDS_ON',
          relatedSpdxElement: zlib.SPDXID,
        },
        {
          spdxElementId: generator.SPDXID,
          relationshipType: 'BUILD_DEPENDENCY_OF',
          relatedSpdxElement: ffmpeg.SPDXID,
        },
      ]),
    );
  });

  it('does not invent unknown versions, download locations or declared licences', () => {
    const input = fixture();
    input.packages.push({ key: 'unknown', name: 'observed-input' });
    const unknown = createSpdx(input).packages.find((item) => item.name === 'observed-input')!;
    expect(unknown).not.toHaveProperty('versionInfo');
    expect(unknown.downloadLocation).toBe('NOASSERTION');
    expect(unknown.licenseDeclared).toBe('NOASSERTION');
    expect(unknown.externalRefs[0]!.referenceLocator).toBe('pkg:generic/observed-input');
  });

  it('is deterministic regardless of input ordering and distinguishes different source revisions', () => {
    const input = fixture();
    const document = createSpdx(input);
    expect(
      createSpdx({
        ...input,
        packages: [...input.packages].reverse(),
        relationships: [...input.relationships].reverse(),
      }),
    ).toEqual(document);
    const changed = fixture();
    changed.packages[0]!.sha256 = 'c'.repeat(64);
    expect(createSpdx(changed).documentNamespace).not.toBe(document.documentNamespace);
    expect(createSpdx({ ...input, platform: 'win-x64' }).documentNamespace).not.toBe(
      document.documentNamespace,
    );
    for (const item of document.packages) {
      expect(item.SPDXID).toMatch(/^SPDXRef-[A-Za-z0-9.-]+$/);
    }
  });

  it('retains actual custom licence text and refuses unresolved licence references', () => {
    const input = fixture();
    input.packages[1]!.license = 'MIT AND LicenseRef-Example';
    expect(() => createSpdx(input)).toThrow(/LicenseRef-Example/);
    input.licenses = [
      { licenseId: 'LicenseRef-Example', extractedText: 'The actual fixture licence text.' },
    ];
    expect(createSpdx(input).hasExtractedLicensingInfos).toEqual(input.licenses);
  });

  it('rejects broken relationships, ambiguous component keys and malformed source hashes', () => {
    const missing = fixture();
    missing.relationships.push({ from: 'ffmpeg', to: 'not-recorded', type: 'DEPENDS_ON' });
    expect(() => createSpdx(missing)).toThrow(/not-recorded/);
    const duplicate = fixture();
    duplicate.packages.push({ key: 'zlib', name: 'different-library' });
    expect(() => createSpdx(duplicate)).toThrow(/duplicate.*zlib/i);
    const malformed = fixture();
    malformed.packages[0]!.sha256 = 'not-a-source-hash';
    expect(() => createSpdx(malformed)).toThrow(/sha256/i);
  });
});
