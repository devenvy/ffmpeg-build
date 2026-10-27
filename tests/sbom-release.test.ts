import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixtureSbom } from './helpers/sbom.ts';
import { checkSbomInputs, combineBuildSboms, readBuildSbom } from '../src/sbom-release.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function fixture(different = false, custom = false) {
  const dist = mkdtempSync(join(tmpdir(), 'ffmpeg-sbom-release-'));
  roots.push(dist);
  const inputs = ['arm64', 'x64'].map((platform, index) => {
    const name = `input-${platform}`;
    const archive = join(dist, `${name}.tar.gz`);
    writeFileSync(archive, `runtime ${platform}`);
    writeFileSync(join(dist, `${name}-dev.tar.gz`), `sdk ${platform}`);
    const sbom = fixtureSbom(dist, name, platform, {
      packages: [
        {
          key: 'shared',
          name: 'shared-library',
          version: different && index ? '2.0' : '1.0',
          license: custom ? 'MIT AND LicenseRef-Custom' : 'MIT',
        },
        { key: 'tool', name: 'build-generator', version: '3.0', license: 'MIT' },
      ],
      relationships: [
        { from: `${name}.tar.gz`, to: 'shared', type: 'DEPENDS_ON' },
        { from: 'tool', to: `${name}.tar.gz`, type: 'BUILD_DEPENDENCY_OF' },
      ],
      ...(custom
        ? {
            licenses: [
              {
                licenseId: 'LicenseRef-Custom',
                extractedText: `Actual fixture licence ${platform}.`,
              },
            ],
          }
        : {}),
    });
    return { archive, sbom: join(dist, sbom) };
  });
  const archive = join(dist, 'combined.tar.gz');
  writeFileSync(archive, 'actual combined archive fixture bytes');
  return {
    dist,
    archive,
    inputs,
    target: 'ios-lgplv3',
    platform: 'ios',
    version: '9.1.0',
    engine: 'test',
    created: '2026-10-27T00:00:00Z',
  };
}

function verify(input: ReturnType<typeof fixture>, document: ReturnType<typeof combineBuildSboms>) {
  const path = join(input.dist, 'combined.spdx.json');
  writeFileSync(path, JSON.stringify(document, null, 2));
  if (process.env['FFB_SPDX_VALIDATOR']) {
    execFileSync(process.env['FFB_SPDX_VALIDATOR'], ['-i', path], { stdio: 'pipe' });
  }
  return readBuildSbom(path, [input.archive]);
}

describe('combined build inventories', () => {
  it('rejects conflicting duplicate local licence definitions before merging', () => {
    const input = fixture(false, true);
    const first = input.inputs[0]!;
    const document = readBuildSbom(first.sbom, [first.archive]);
    document.hasExtractedLicensingInfos!.push({
      licenseId: 'LicenseRef-Custom',
      extractedText: 'Conflicting second text.',
    });
    writeFileSync(first.sbom, JSON.stringify(document));
    expect(() => combineBuildSboms(input)).toThrow(/duplicate.*licen[cs]e|licen[cs]e.*duplicate/);
  });
  it('deduplicates identical inputs, retains build tools, excludes unused SDK archive roots and binds the final archive', () => {
    const input = fixture();
    const document = verify(input, combineBuildSboms(input));
    expect(document.packages.filter((item) => item.name === 'shared-library')).toHaveLength(1);
    expect(document.packages.filter((item) => item.name === 'build-generator')).toHaveLength(1);
    expect(document.packages.some((item) => item.name.endsWith('-dev.tar.gz'))).toBe(false);
    const combined = document.packages.find((item) => item.name === 'combined.tar.gz')!;
    expect(combined.checksums).toEqual([
      { algorithm: 'SHA256', checksumValue: hash(readFileSync(input.archive)) },
    ]);
    expect(document.relationships.filter((item) => item.relationshipType === 'DESCRIBES')).toEqual([
      expect.objectContaining({
        spdxElementId: document.SPDXID,
        relatedSpdxElement: combined.SPDXID,
      }),
    ]);
    checkSbomInputs(
      document,
      input.inputs.map((item) => item.sbom),
    );
  });

  it('does not conflate equal document-local identifiers for different versions', () => {
    const input = fixture(true);
    const document = verify(input, combineBuildSboms(input));
    expect(
      document.packages
        .filter((item) => item.name === 'shared-library')
        .map((item) => item.versionInfo)
        .sort((a, b) => (a ?? '').localeCompare(b ?? '', 'en')),
    ).toEqual(['1.0', '2.0']);
  });

  it('remaps document-local licence references without mixing their actual texts', () => {
    const input = fixture(false, true);
    const document = verify(input, combineBuildSboms(input));
    expect(document.hasExtractedLicensingInfos?.map((item) => item.extractedText).sort()).toEqual([
      'Actual fixture licence arm64.',
      'Actual fixture licence x64.',
    ]);
    const declarations = document.packages
      .filter((item) => item.name === 'shared-library')
      .map((item) => item.licenseDeclared);
    expect(new Set(declarations).size).toBe(2);
    expect(declarations.every((item) => item.startsWith('MIT AND LicenseRef-Merged-'))).toBe(true);
  });

  it('is deterministic across input ordering and detects metadata-only changes to an input inventory', () => {
    const input = fixture();
    const document = combineBuildSboms(input);
    expect(combineBuildSboms({ ...input, inputs: [...input.inputs].reverse() })).toEqual(document);
    const first = input.inputs[0]!;
    const edited = readBuildSbom(first.sbom, [first.archive]);
    edited.comment = 'Updated metadata, same archive bytes.';
    edited.documentNamespace += '-new-metadata';
    writeFileSync(first.sbom, JSON.stringify(edited));
    expect(() =>
      checkSbomInputs(
        document,
        input.inputs.map((item) => item.sbom),
      ),
    ).toThrow(/stale/);
  });
});
