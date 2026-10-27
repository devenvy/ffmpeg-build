// Build-side inventory: use the sources actually fetched and the licences staged for this build. Recipe inputs
// describe a build dependency graph; they are not a claim that every static archive member reached the binary.
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { normalizeSpdx } from './cargo.ts';
import { sha256, type SourceRecord } from './fetch.ts';
import { createSpdx, sbomDownloadLocation, type SpdxInput } from '../sbom.ts';
import { symbolsName } from '../targets.ts';
import { JSON_INDENT } from '../text.ts';

import type { BuildContext } from './library.ts';

type Entry = SpdxInput['packages'][number];
const LICENSE_ID_DIGITS = 16;
interface LicenceFile {
  path: string;
  text: string;
}
type Plan = BuildContext['buildPlan'];
type SbomContext = Pick<BuildContext, 'out' | 'work' | 'depsDir'> & {
  buildPlan: Pick<
    Plan,
    | 'name'
    | 'target'
    | 'platform'
    | 'engine'
    | 'toolchain'
    | 'license'
    | 'release'
    | 'patches'
    | 'ships'
  > & {
    libraries: Pick<
      Plan['libraries'][number],
      'name' | 'version' | 'license' | 'linkage' | 'licenseFiles' | 'dependencies'
    >[];
  };
};

const buildLicence = {
  lgplv2: 'LGPL-2.1-or-later',
  lgplv3: 'LGPL-3.0-or-later',
  gplv2: 'GPL-2.0-or-later',
  gplv3: 'GPL-3.0-or-later',
  nonfree: 'NOASSERTION',
};
const sourceKey = (record: SourceRecord): string =>
  `source:${record.name}:${record.version}:${record.sha256}`;

/** Sidecar generation happens after packaging so the archive hashes describe the exact delivered bytes. */
export function writeBuildSbom(
  context: SbomContext,
  ffmpeg: SourceRecord,
  records: readonly SourceRecord[],
): void {
  const plan = context.buildPlan;
  const packages = new Map<string, Entry>();
  const relationships: SpdxInput['relationships'] = [];
  const licenses: NonNullable<SpdxInput['licenses']> = [];
  const extracted = new Map<string, string>();
  const add = (entry: Entry): string => {
    const previous = packages.get(entry.key);
    if (previous) {
      if (
        previous.name !== entry.name ||
        previous.version !== entry.version ||
        previous.sha256 !== entry.sha256
      ) {
        throw new Error(`SBOM: conflicting observed source identity ${entry.key}`);
      }
      return entry.key;
    }
    packages.set(entry.key, entry);
    return entry.key;
  };
  const edge = (
    from: string,
    to: string,
    type: SpdxInput['relationships'][number]['type'],
    comment?: string,
  ) => {
    relationships.push({ from, to, type, ...(comment ? { comment } : {}) });
  };
  const declaration = (
    expression: string | undefined,
    files: LicenceFile[],
    key: string,
  ): Pick<Entry, 'license' | 'licenseComments'> => {
    if (!expression) {
      return {};
    }
    const references = [...new Set(expression.match(/LicenseRef-[A-Za-z0-9.-]+/g) ?? [])];
    if (!references.length && expression !== 'proprietary') {
      return { license: expression };
    }
    const identifier = expression === 'proprietary' ? 'LicenseRef-User-Patch' : undefined;
    const originals = identifier ? [identifier] : references;
    const selected = originals.map((reference) => {
      const token = reference
        .slice('LicenseRef-'.length)
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
      const found =
        expression === reference || identifier
          ? files
          : files.filter((file) =>
              file.path
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .includes(token),
            );
      return { reference, found };
    });
    if (selected.some(({ found }) => !found.length)) {
      return {
        licenseComments: `Recipe declaration: ${expression}. The custom licence text is not separately identified in this inventory; consult THIRD-PARTY-NOTICES.txt and the corresponding source.`,
      };
    }
    const suffix = createHash('sha256').update(key).digest('hex').slice(0, LICENSE_ID_DIGITS);
    const mapping = new Map<string, string>();
    for (const { reference, found } of selected) {
      const licenseId = `${reference}-${suffix}`;
      mapping.set(reference, licenseId);
      const extractedText = found.map((file) => file.text).join('\n\n');
      const previous = extracted.get(licenseId);
      if (previous !== undefined && previous !== extractedText) {
        throw new Error(`SBOM: conflicting extracted licence text for ${licenseId}`);
      }
      if (previous === undefined) {
        extracted.set(licenseId, extractedText);
        licenses.push({
          licenseId,
          extractedText,
          comment: `Actual staged licence files: ${found.map((file) => file.path).join(', ')}. Recipe declaration: ${expression}.`,
        });
      }
    }
    return {
      license: identifier
        ? mapping.get(identifier)!
        : expression.replace(/LicenseRef-[A-Za-z0-9.-]+/g, (reference) => mapping.get(reference)!),
      licenseComments: `Recipe declaration: ${expression}. Custom identifiers are local to this SPDX document.`,
    };
  };
  const observed = (record: SourceRecord, extra: Partial<Entry> = {}): Entry => ({
    key: sourceKey(record),
    name: record.name,
    version: record.version,
    downloadLocation: sbomDownloadLocation(record.origin),
    sha256: record.sha256,
    purpose: 'SOURCE',
    sourceInfo: `Observed source archive: ${record.file}; origin: ${record.origin}${record.commit ? `; commit: ${record.commit}` : ''}. The checksum identifies the kept source archive.`,
    ...extra,
  });
  const ffmpegKey = add(
    observed(ffmpeg, {
      licenseComments: `Upstream source contains multiple licensing terms; the selected build class is ${plan.license}. Consult FFmpeg's LICENSE.md and THIRD-PARTY-NOTICES.txt.`,
    }),
  );
  const symbols = symbolsName(plan.name);
  const artifacts = [
    `${plan.name}.tar.gz`,
    `${plan.name}-dev.tar.gz`,
    ...(existsSync(join(context.out, symbols)) ? [symbols] : []),
  ];
  const describes = artifacts.map((name) =>
    add({
      key: `artifact:${name}`,
      name,
      version: plan.release ?? ffmpeg.version,
      sha256: sha256(join(context.out, name)),
      license: buildLicence[plan.license],
      purpose: 'ARCHIVE',
      sourceInfo: `Build target: ${plan.target}; platform: ${plan.platform}; toolchain identity: ${plan.toolchain}.`,
      licenseComments: `Configured FFmpeg build class: ${plan.license}. Per-component declarations are recorded separately; no legal conclusion is asserted.`,
    }),
  );
  for (const artifact of describes) {
    edge(artifact, ffmpegKey, 'GENERATED_FROM');
  }
  const libraryKeys = new Map<string, string>();
  for (const library of plan.libraries) {
    const record = records.find((item) => item.name === library.name);
    if (!record) {
      throw new Error(`SBOM: ${library.name} has no observed source record`);
    }
    if (record.version !== library.version) {
      throw new Error(
        `SBOM: ${library.name}'s observed source version ${record.version} differs from the planned ${library.version}`,
      );
    }
    const key = sourceKey(record);
    const files = /LicenseRef-|^proprietary$/.test(library.license)
      ? library.licenseFiles.map((file) => ({
          path: file.path,
          text: readFileSync(
            join(context.depsDir, 'share/ffmpeg-build/legal', library.name, file.path),
            'utf8',
          ),
        }))
      : [];
    add(observed(record, declaration(library.license, files, key)));
    libraryKeys.set(library.name, key);
    for (const artifact of describes) {
      if (library.linkage) {
        edge(
          artifact,
          key,
          'DEPENDS_ON',
          `Resolved library build input; selected linkage: ${library.linkage}. This does not assert that every archive object was linked.`,
        );
      } else {
        edge(
          key,
          artifact,
          'BUILD_DEPENDENCY_OF',
          'Resolved build input; no runtime linkage mode is declared.',
        );
      }
    }
    for (const crate of record.crates ?? []) {
      const crateKey = `crate:${crate.source}:${crate.name}:${crate.version}:${crate.sha256 ?? key}`;
      const crateFiles =
        crate.linked && crate.license?.includes('LicenseRef-')
          ? crate.texts.map((file) => ({
              path: file,
              text: readFileSync(
                join(
                  context.depsDir,
                  'share/ffmpeg-build/legal',
                  library.name,
                  'crates',
                  `${crate.name}-${crate.version}`,
                  file,
                ),
                'utf8',
              ),
            }))
          : [];
      const cargoLicense: Pick<Entry, 'license' | 'licenseComments'> = crate.linked
        ? declaration(
            crate.license ? normalizeSpdx(crate.license) : undefined,
            crateFiles,
            crateKey,
          )
        : {};
      add({
        key: crateKey,
        name: crate.name,
        version: crate.version,
        ...(crate.sha256 ? { sha256: crate.sha256 } : {}),
        ...(crate.source === 'crates.io'
          ? {
              purl: `pkg:cargo/${encodeURIComponent(crate.name)}@${encodeURIComponent(crate.version)}`,
              downloadLocation: `https://crates.io/api/v1/crates/${encodeURIComponent(crate.name)}/${encodeURIComponent(crate.version)}/download`,
            }
          : {}),
        ...cargoLicense,
        ...(crate.license
          ? {
              licenseComments: [
                cargoLicense.licenseComments,
                `Cargo declaration: ${crate.license}.${crate.linked ? '' : ' Source-only metadata; its licence declaration was not validated by the build.'}`,
              ]
                .filter(Boolean)
                .join(' '),
            }
          : {}),
        purpose: 'SOURCE',
        sourceInfo:
          crate.source === 'path'
            ? `Path dependency captured in ${record.name}'s source (${record.sha256}).`
            : 'Crate identity recorded by Cargo for this build.',
      });
      edge(
        key,
        crateKey,
        crate.linked ? 'DEPENDS_ON' : 'OTHER',
        crate.linked
          ? 'Cargo records this crate as linked into the library.'
          : 'Resolved source inventory only; not recorded as linked. May be tooling, tests or another platform.',
      );
    }
    if (record.rust) {
      const rust = add({
        key: `rust-std:${record.rust.version}:${plan.platform}`,
        name: 'rust-standard-library',
        version: record.rust.version,
        purpose: 'LIBRARY',
        sourceInfo: `Rust standard library recorded as linked for ${plan.platform}. Its combined notices are included in THIRD-PARTY-NOTICES.txt; its internal dependency inventory is not expanded here.`,
      });
      edge(key, rust, 'DEPENDS_ON');
    }
    for (const source of (record.supplementalSources ?? []).filter(
      (input) => input.kind !== 'metadata',
    )) {
      const supplemental = add({
        key: `supplemental:${source.repository}:${source.sha256}`,
        name: source.repository,
        sha256: source.sha256,
        downloadLocation: sbomDownloadLocation(source.origin),
        purpose: source.kind === 'source' ? 'SOURCE' : 'APPLICATION',
        sourceInfo: `Captured ${source.kind}: ${source.filename}; origin: ${source.origin}. Version and licence were not recorded separately.`,
      });
      edge(
        supplemental,
        key,
        'BUILD_DEPENDENCY_OF',
        'Captured build input; this does not assert runtime inclusion.',
      );
    }
  }
  for (const library of plan.libraries) {
    for (const dependency of library.dependencies ?? []) {
      const target = libraryKeys.get(dependency);
      if (!target) {
        throw new Error(`SBOM: ${library.name} depends on unrecorded input ${dependency}`);
      }
      edge(
        libraryKeys.get(library.name)!,
        target,
        'DEPENDS_ON',
        'Resolved recipe dependency for this platform and build configuration.',
      );
    }
  }
  for (const patch of plan.patches) {
    const key = `patch:${patch.name}:${patch.sha256}`;
    add({
      key,
      name: patch.name,
      purpose: 'SOURCE',
      ...declaration(patch.license, patch.licenses, key),
      sourceInfo: `User-selected patch set. Tree SHA-256 (paths and contents, not an archive checksum): ${patch.sha256}.`,
    });
    edge(key, ffmpegKey, 'PATCH_FOR');
    for (const artifact of describes) {
      edge(artifact, key, 'GENERATED_FROM');
    }
  }
  for (const shipped of plan.ships) {
    const matches = globSync(`**/${basename(shipped.file)}`, {
      cwd: join(context.work, 'stage/run'),
    });
    const names = matches.length ? matches : [basename(shipped.file)];
    for (const name of names) {
      const path = join(context.work, 'stage/run', name);
      const hash = existsSync(path) ? sha256(path) : undefined;
      const key = add({
        key: `toolchain:${name}:${hash ?? plan.toolchain}`,
        name: basename(name),
        ...(hash ? { sha256: hash } : {}),
        ...declaration(shipped.license, [], name),
        purpose: 'LIBRARY',
        sourceInfo: `Toolchain-supplied input: ${shipped.file}; toolchain identity: ${plan.toolchain}. Its library version was not recorded.${hash ? ` Checksum identifies the staged runtime file: ${name.replaceAll('\\', '/')}.` : ''}`,
      });
      if (hash) {
        edge(describes[0]!, key, 'CONTAINS', 'File observed in the staged runtime archive.');
      } else {
        for (const artifact of describes) {
          edge(key, artifact, 'BUILD_DEPENDENCY_OF');
        }
      }
    }
  }
  const document = createSpdx({
    name: plan.name,
    target: plan.target,
    platform: plan.platform,
    engine: plan.engine,
    created: new Date().toISOString(),
    describes,
    packages: [...packages.values()],
    relationships,
    licenses,
  });
  writeFileSync(
    join(context.out, `${plan.name}.spdx.json`),
    `${JSON.stringify(document, null, JSON_INDENT)}\n`,
  );
}
