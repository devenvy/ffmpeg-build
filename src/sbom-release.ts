// Validate the builder's SPDX sidecars before publication. The manifest stays readable by older clients;
// sidecars are independently named assets, bound to their archive bytes and covered by SHA256SUMS.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { z } from 'zod';

import { sha256 } from './build/fetch.ts';
import { createSpdx } from './sbom.ts';

const identifier = z.string().regex(/^SPDXRef-[A-Za-z0-9.-]+$/);
const checksum = z.object({
  algorithm: z.literal('SHA256'),
  checksumValue: z.string().regex(/^[0-9a-f]{64}$/),
});
const component = z
  .object({
    SPDXID: identifier,
    name: z.string().min(1),
    versionInfo: z.string().optional(),
    downloadLocation: z.string(),
    filesAnalyzed: z.literal(false),
    checksums: z.array(checksum).optional(),
    licenseConcluded: z.literal('NOASSERTION'),
    licenseDeclared: z.string(),
    licenseComments: z.string().optional(),
    copyrightText: z.literal('NOASSERTION'),
    sourceInfo: z.string().optional(),
    primaryPackagePurpose: z
      .enum(['APPLICATION', 'LIBRARY', 'SOURCE', 'ARCHIVE', 'OTHER'])
      .optional(),
    externalRefs: z.array(
      z
        .object({
          referenceCategory: z.literal('PACKAGE-MANAGER'),
          referenceType: z.literal('purl'),
          referenceLocator: z.string(),
        })
        .loose(),
    ),
  })
  .loose();
const documentSchema = z
  .object({
    spdxVersion: z.literal('SPDX-2.3'),
    dataLicense: z.literal('CC0-1.0'),
    SPDXID: z.literal('SPDXRef-DOCUMENT'),
    name: z.string(),
    documentNamespace: z.url(),
    creationInfo: z.object({ created: z.string(), creators: z.array(z.string()) }).loose(),
    comment: z.string(),
    packages: z.array(component).min(1),
    relationships: z.array(
      z
        .object({
          spdxElementId: z.string(),
          relatedSpdxElement: z.string(),
          relationshipType: z.enum([
            'DEPENDS_ON',
            'BUILD_DEPENDENCY_OF',
            'GENERATED_FROM',
            'CONTAINS',
            'STATIC_LINK',
            'DYNAMIC_LINK',
            'PATCH_FOR',
            'OTHER',
            'DESCRIBES',
          ]),
          comment: z.string().optional(),
        })
        .loose(),
    ),
    hasExtractedLicensingInfos: z
      .array(
        z
          .object({
            licenseId: z.string().regex(/^LicenseRef-[A-Za-z0-9.-]+$/),
            extractedText: z.string().min(1),
            comment: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    externalDocumentRefs: z
      .array(
        z
          .object({
            externalDocumentId: z.string().regex(/^DocumentRef-[A-Za-z0-9.-]+$/),
            spdxDocument: z.url(),
            checksum,
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

type BuildSbomDocument = z.output<typeof documentSchema>;
type Component = BuildSbomDocument['packages'][number];
type Edge = BuildSbomDocument['relationships'][number];

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

const fingerprint = (value: unknown): string => digest(JSON.stringify(canonical(value)));

/** The builder's document shape plus referential integrity and exact archive bindings. */
export function readBuildSbom(file: string, archives: readonly string[]): BuildSbomDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`SBOM ${basename(file)} is not readable JSON`);
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `SBOM ${basename(file)} is not a supported build SPDX document: ${parsed.error.issues[0]!.path.join('.')}`,
    );
  }
  const document = parsed.data;
  const identifiers = new Set(document.packages.map((item) => item.SPDXID));
  if (identifiers.size !== document.packages.length) {
    throw new Error(`SBOM ${basename(file)} repeats a package identifier`);
  }
  identifiers.add(document.SPDXID);
  const external = new Set(
    (document.externalDocumentRefs ?? []).map((item) => item.externalDocumentId),
  );
  const isKnown = (value: string): boolean =>
    identifiers.has(value) ||
    (external.has(value.split(':')[0]!) &&
      /^DocumentRef-[A-Za-z0-9.-]+:SPDXRef-[A-Za-z0-9.-]+$/.test(value));
  for (const relationship of document.relationships) {
    if (!isKnown(relationship.spdxElementId) || !isKnown(relationship.relatedSpdxElement)) {
      throw new Error(`SBOM ${basename(file)} contains a dangling dependency relationship`);
    }
  }
  const licenses = new Set(
    (document.hasExtractedLicensingInfos ?? []).map((item) => item.licenseId),
  );
  if (licenses.size !== (document.hasExtractedLicensingInfos ?? []).length) {
    throw new Error(`SBOM ${basename(file)} contains a duplicate licence identifier`);
  }
  for (const item of document.packages) {
    for (const reference of item.licenseDeclared.match(/LicenseRef-[A-Za-z0-9.-]+/g) ?? []) {
      if (!licenses.has(reference)) {
        throw new Error(`SBOM ${basename(file)} has no extracted text for ${reference}`);
      }
    }
  }
  for (const archive of archives) {
    const name = basename(archive);
    const matching = document.packages.filter(
      (item) => item.name === name && item.primaryPackagePurpose === 'ARCHIVE',
    );
    const packageRecord = matching[0];
    if (
      matching.length !== 1 ||
      !packageRecord ||
      packageRecord.checksums?.length !== 1 ||
      packageRecord.checksums[0]!.checksumValue !== sha256(archive)
    ) {
      throw new Error(`SBOM ${basename(file)} does not match ${name}; build or bundle it again`);
    }
    if (
      !document.relationships.some(
        (item) =>
          item.spdxElementId === document.SPDXID &&
          item.relationshipType === 'DESCRIBES' &&
          item.relatedSpdxElement === packageRecord.SPDXID,
      )
    ) {
      throw new Error(`SBOM ${basename(file)} does not describe ${name}`);
    }
  }
  return document;
}

interface CombinedSbom {
  archive: string;
  inputs: { sbom: string; archive: string }[];
  target: string;
  platform: string;
  version: string;
  engine: string;
  created: string;
}

/** Merge document-local identifiers by their facts, retaining build scope and exact input-SBOM provenance. */
export function combineBuildSboms(input: CombinedSbom): BuildSbomDocument {
  if (!input.inputs.length) {
    throw new Error('SBOM bundle has no input inventories');
  }
  const sources = input.inputs
    .map((item) => ({
      ...item,
      document: readBuildSbom(item.sbom, [item.archive]),
      checksum: sha256(item.sbom),
    }))
    .sort((a, b) => a.sbom.localeCompare(b.sbom, 'en'));
  const parents = sources.map((source) =>
    source.document.packages.find((item) => item.name === basename(source.archive))!,
  );
  const licences = [...new Set(parents.map((item) => item.licenseDeclared))];
  const base = documentSchema.parse(
    createSpdx({
      name: basename(input.archive, '.tar.gz'),
      target: input.target,
      platform: input.platform,
      engine: input.engine,
      created: input.created,
      describes: ['bundle'],
      packages: [
        {
          key: 'bundle',
          name: basename(input.archive),
          version: input.version,
          sha256: sha256(input.archive),
          purpose: 'ARCHIVE',
          license:
            licences.length === 1 && !licences[0]!.includes('LicenseRef-')
              ? licences[0]!
              : 'NOASSERTION',
          sourceInfo:
            'Combined archive inventory. Input archives and build inputs are retained as provenance, not claimed as files nested inside this archive.',
        },
      ],
      relationships: [],
    }),
  );
  const root = base.packages[0]!.SPDXID;
  const packages = new Map<string, Component>([[root, base.packages[0]!]]);
  const edges = [...base.relationships];
  const definitions = new Map<
    string,
    NonNullable<BuildSbomDocument['hasExtractedLicensingInfos']>[number]
  >();
  const external = new Map<
    string,
    NonNullable<BuildSbomDocument['externalDocumentRefs']>[number]
  >();
  for (const [index, source] of sources.entries()) {
    const document = source.document;
    const reference = `DocumentRef-${source.checksum}`;
    external.set(reference, {
      externalDocumentId: reference,
      spdxDocument: document.documentNamespace,
      checksum: { algorithm: 'SHA256', checksumValue: source.checksum },
    });
    const externalIds = new Map<string, string>();
    for (const item of document.externalDocumentRefs ?? []) {
      const id = `DocumentRef-${fingerprint({ document: item.spdxDocument, checksum: item.checksum })}`;
      externalIds.set(item.externalDocumentId, id);
      external.set(id, { ...item, externalDocumentId: id });
    }
    const localLicences = new Map<string, string>();
    for (const { licenseId, ...facts } of document.hasExtractedLicensingInfos ?? []) {
      const id = `LicenseRef-Merged-${fingerprint(facts)}`;
      localLicences.set(licenseId, id);
      definitions.set(id, { ...facts, licenseId: id });
    }
    const originalPackages = new Set(document.packages.map((item) => item.SPDXID));
    const reachable = new Set<string>([parents[index]!.SPDXID]);
    let previousSize = -1;
    while (previousSize !== reachable.size) {
      previousSize = reachable.size;
      for (const edge of document.relationships) {
        if (reachable.has(edge.spdxElementId) && originalPackages.has(edge.relatedSpdxElement)) {
          reachable.add(edge.relatedSpdxElement);
        }
        if (
          edge.relationshipType === 'BUILD_DEPENDENCY_OF' &&
          reachable.has(edge.relatedSpdxElement) &&
          originalPackages.has(edge.spdxElementId)
        ) {
          reachable.add(edge.spdxElementId);
        }
      }
    }
    const identifiers = new Map<string, string>();
    for (const item of document.packages.filter((candidate) => reachable.has(candidate.SPDXID))) {
      const { SPDXID, ...facts } = item;
      const normalized = {
        ...facts,
        licenseDeclared: item.licenseDeclared.replace(/LicenseRef-[A-Za-z0-9.-]+/g, (id) =>
          localLicences.get(id)!,
        ),
      };
      const id = `SPDXRef-Merged-${fingerprint(normalized)}`;
      identifiers.set(SPDXID, id);
      packages.set(id, { ...normalized, SPDXID: id });
    }
    const mapped = (id: string): string => {
      if (id === document.SPDXID) {
        return `${reference}:${document.SPDXID}`;
      }
      const local = identifiers.get(id);
      if (local) {
        return local;
      }
      const [prefix, suffix] = id.split(':');
      const translated = prefix && externalIds.get(prefix);
      if (translated && suffix) {
        return `${translated}:${suffix}`;
      }
      throw new Error(`SBOM bundle cannot resolve ${id}`);
    };
    for (const edge of document.relationships) {
      const relevantFrom = reachable.has(edge.spdxElementId);
      const relevantTo =
        reachable.has(edge.relatedSpdxElement) || edge.relatedSpdxElement.includes(':');
      if (relevantFrom && relevantTo) {
        edges.push({
          ...edge,
          spdxElementId: mapped(edge.spdxElementId),
          relatedSpdxElement: mapped(edge.relatedSpdxElement),
        });
      }
    }
    edges.push({
      spdxElementId: root,
      relationshipType: 'GENERATED_FROM',
      relatedSpdxElement: mapped(parents[index]!.SPDXID),
    });
    edges.push({
      spdxElementId: base.SPDXID,
      relationshipType: 'GENERATED_FROM',
      relatedSpdxElement: `${reference}:${document.SPDXID}`,
    });
  }
  const uniqueEdges = new Map<string, Edge>();
  for (const edge of edges) {
    uniqueEdges.set(
      JSON.stringify([
        edge.spdxElementId,
        edge.relationshipType,
        edge.relatedSpdxElement,
        edge.comment,
      ]),
      edge,
    );
  }
  const componentList = [...packages.keys()].sort().map((key) => packages.get(key)!);
  const referencedLicences = new Set(
    componentList.flatMap((item) => item.licenseDeclared.match(/LicenseRef-[A-Za-z0-9.-]+/g) ?? []),
  );
  const document: BuildSbomDocument = {
    ...base,
    packages: componentList,
    relationships: [...uniqueEdges.keys()].sort().map((key) => uniqueEdges.get(key)!),
    hasExtractedLicensingInfos: [...definitions.keys()]
      .filter((key) => referencedLicences.has(key))
      .sort()
      .map((key) => definitions.get(key)!),
    externalDocumentRefs: [...external.keys()].sort().map((key) => external.get(key)!),
  };
  document.documentNamespace = `https://spdx.org/spdxdocs/ffmpeg-build-${fingerprint({ ...document, documentNamespace: undefined })}`;
  return document;
}

/** A bundle's inventory must follow metadata changes as well as archive rebuilds. */
export function checkSbomInputs(document: BuildSbomDocument, inputs: readonly string[]): void {
  for (const file of inputs) {
    const source = readBuildSbom(file, []);
    const checksumValue = sha256(file);
    if (
      !document.externalDocumentRefs?.some(
        (item) =>
          item.spdxDocument === source.documentNamespace &&
          item.checksum.checksumValue === checksumValue,
      )
    ) {
      throw new Error(
        `SBOM bundle is stale: input ${basename(file)} no longer matches; bundle it again`,
      );
    }
  }
}
