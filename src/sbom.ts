// SPDX 2.3 JSON for the product built by this engine. Callers supply observed identities and relationships;
// choosing a static recipe does not by itself prove that all of its objects occur in the final binary.
import { createHash } from 'node:crypto';

type Relationship =
  | 'DEPENDS_ON'
  | 'BUILD_DEPENDENCY_OF'
  | 'GENERATED_FROM'
  | 'CONTAINS'
  | 'STATIC_LINK'
  | 'DYNAMIC_LINK'
  | 'OTHER'
  | 'PATCH_FOR';

interface PackageInput {
  key: string;
  name: string;
  version?: string;
  downloadLocation?: string;
  sha256?: string;
  license?: string;
  licenseComments?: string;
  sourceInfo?: string;
  purl?: string;
  purpose?: 'APPLICATION' | 'LIBRARY' | 'SOURCE' | 'ARCHIVE' | 'OTHER';
}

interface ExtractedLicense {
  licenseId: string;
  extractedText: string;
  comment?: string;
}

export interface SpdxInput {
  name: string;
  target: string;
  platform: string;
  engine: string;
  created: string;
  describes: string[];
  packages: PackageInput[];
  relationships: { from: string; to: string; type: Relationship; comment?: string }[];
  licenses?: ExtractedLicense[];
}

interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  downloadLocation: string;
  filesAnalyzed: false;
  checksums?: { algorithm: 'SHA256'; checksumValue: string }[];
  licenseConcluded: 'NOASSERTION';
  licenseDeclared: string;
  licenseComments?: string;
  copyrightText: 'NOASSERTION';
  sourceInfo?: string;
  primaryPackagePurpose?: PackageInput['purpose'];
  externalRefs: {
    referenceCategory: 'PACKAGE-MANAGER';
    referenceType: 'purl';
    referenceLocator: string;
  }[];
}

interface SpdxRelationship {
  spdxElementId: string;
  relationshipType: Relationship | 'DESCRIBES';
  relatedSpdxElement: string;
  comment?: string;
}

interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[] };
  comment: string;
  packages: SpdxPackage[];
  relationships: SpdxRelationship[];
  hasExtractedLicensingInfos?: ExtractedLicense[];
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
const HEX_RADIX = 16;
const encoded = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`,
  );

/** Machine-local paths remain provenance, not asserted downloadable package URLs. */
export function sbomDownloadLocation(origin: string): string {
  return URL.canParse(origin) &&
    /^(?:(?:git|hg|svn|bzr)\+)?(?:https?|ssh|git|svn|sftp|ftp):\/\//i.test(origin)
    ? origin
    : 'NOASSERTION';
}

function packageUrl(input: PackageInput): string {
  if (input.purl) {
    if (!/^pkg:[a-z][a-z0-9.+-]*\/\S+$/.test(input.purl)) {
      throw new Error(`SBOM: invalid package URL for ${input.key}`);
    }
    return input.purl;
  }
  return `pkg:generic/${encoded(input.name)}${input.version ? `@${encoded(input.version)}` : ''}${input.sha256 ? `?checksum=${encoded(`sha256:${input.sha256}`)}` : ''}`;
}

/** A stable, serializable SPDX document. The same inputs give the same bytes and namespace. */
export function createSpdx(input: SpdxInput): SpdxDocument {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.created) ||
    Number.isNaN(Date.parse(input.created))
  ) {
    throw new Error('SBOM: created must be a UTC timestamp');
  }
  if (!input.name || !input.packages.length || !input.describes.length) {
    throw new Error('SBOM: a named document must describe at least one package');
  }
  const identifiers = new Map<string, string>();
  const licenses = [...(input.licenses ?? [])].sort((a, b) => compare(a.licenseId, b.licenseId));
  const knownLicenses = new Set<string>();
  for (const license of licenses) {
    if (!/^LicenseRef-[A-Za-z0-9.-]+$/.test(license.licenseId) || !license.extractedText.trim()) {
      throw new Error(`SBOM: invalid extracted licence ${license.licenseId}`);
    }
    if (knownLicenses.has(license.licenseId)) {
      throw new Error(`SBOM: duplicate extracted licence ${license.licenseId}`);
    }
    knownLicenses.add(license.licenseId);
  }
  const packages: SpdxPackage[] = [...input.packages]
    .sort((a, b) => compare(a.key, b.key))
    .map((item) => {
      if (!item.key || !item.name.trim() || identifiers.has(item.key)) {
        throw new Error(`SBOM: duplicate or empty package key ${item.key}`);
      }
      const identifier = `SPDXRef-Package-${digest(item.key)}`;
      identifiers.set(item.key, identifier);
      if (item.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(item.sha256)) {
        throw new Error(`SBOM: invalid sha256 for ${item.key}`);
      }
      const license = item.license ?? 'NOASSERTION';
      for (const reference of license.match(/LicenseRef-[A-Za-z0-9.-]+/g) ?? []) {
        if (!knownLicenses.has(reference)) {
          throw new Error(
            `SBOM: ${item.key} references ${reference} without its actual licence text`,
          );
        }
      }
      const location = item.downloadLocation ?? 'NOASSERTION';
      if (
        !['NOASSERTION', 'NONE'].includes(location) &&
        sbomDownloadLocation(location) !== location
      ) {
        throw new Error(`SBOM: invalid download location for ${item.key}`);
      }
      return {
        SPDXID: identifier,
        name: item.name,
        ...(item.version === undefined ? {} : { versionInfo: item.version }),
        downloadLocation: location,
        filesAnalyzed: false,
        ...(item.sha256
          ? { checksums: [{ algorithm: 'SHA256', checksumValue: item.sha256 }] }
          : {}),
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: license,
        ...(item.licenseComments ? { licenseComments: item.licenseComments } : {}),
        copyrightText: 'NOASSERTION',
        ...(item.sourceInfo ? { sourceInfo: item.sourceInfo } : {}),
        ...(item.purpose ? { primaryPackagePurpose: item.purpose } : {}),
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: packageUrl(item),
          },
        ],
      };
    });
  const idOf = (key: string): string => {
    const identifier = identifiers.get(key);
    if (!identifier) {
      throw new Error(`SBOM: relationship refers to unrecorded package ${key}`);
    }
    return identifier;
  };
  const relationships: SpdxRelationship[] = [
    ...[...new Set(input.describes)].map((key): SpdxRelationship => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: idOf(key),
    })),
    ...input.relationships.map((relationship): SpdxRelationship => ({
      spdxElementId: idOf(relationship.from),
      relationshipType: relationship.type,
      relatedSpdxElement: idOf(relationship.to),
      ...(relationship.comment ? { comment: relationship.comment } : {}),
    })),
  ].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const content = {
    spdxVersion: 'SPDX-2.3' as const,
    dataLicense: 'CC0-1.0' as const,
    SPDXID: 'SPDXRef-DOCUMENT' as const,
    name: input.name,
    creationInfo: {
      created: input.created.replace(/\.\d+Z$/, 'Z'),
      creators: [`Tool: ffmpeg-build-${input.engine}`],
    },
    comment: `Build inventory for target ${input.target}, platform ${input.platform}. Declared licences are recorded without a legal conclusion. Build inputs are not evidence that every source file is present in a runtime binary.`,
    packages,
    relationships,
    ...(licenses.length ? { hasExtractedLicensingInfos: licenses } : {}),
  };
  return {
    ...content,
    documentNamespace: `https://spdx.org/spdxdocs/ffmpeg-build-${digest(JSON.stringify(content))}`,
  };
}
