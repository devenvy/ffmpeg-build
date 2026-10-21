import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, win32 } from 'node:path';

import { z } from 'zod';

import { keepSource, sha256, SourceIntegrityError } from './fetch.ts';

const input = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  origin: z.string().min(1),
  kind: z.enum(['source', 'build-tool', 'binary-build-tool', 'metadata']),
  repository: z.string().min(1),
  filename: z.string().min(1),
});
const inventory = z.strictObject({ version: z.literal(1), files: z.array(input).min(1) });

export const supplementalSourceSchema = input
  .omit({ path: true })
  .extend({ file: z.string().min(1) });
export type SupplementalSource = z.infer<typeof supplementalSourceSchema>;

/** Resolve only regular files within a canonical source root, including through symlinks. */
function sourceFile(root: string, file: string): string {
  if (
    isAbsolute(file) ||
    win32.isAbsolute(file) ||
    /^[A-Za-z]:/.test(file) ||
    file.includes('\\') ||
    file.split('/').includes('..')
  ) {
    throw new SourceIntegrityError(`supplemental source path escapes its source root: ${file}`);
  }
  const resolved = realpathSync(join(root, file));
  const rel = relative(root, resolved);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    !statSync(resolved).isFile()
  ) {
    throw new SourceIntegrityError(
      `supplemental source is not a regular file inside its source root: ${file}`,
    );
  }
  return resolved;
}

/** Keep pinned downloads and their inventory; digest-derived names cannot be controlled by manifest paths. */
export function keepSupplementalSources(
  src: string,
  sources: string,
  manifest: string,
): SupplementalSource[] {
  const root = realpathSync(src);
  const inventoryPath = sourceFile(root, manifest);
  const inventoryBytes = readFileSync(inventoryPath);
  const parsed = inventory.parse(JSON.parse(inventoryBytes.toString('utf8')));
  mkdirSync(join(sources, 'supplemental'), { recursive: true });
  const keptRoot = realpathSync(sources);
  const keptDirectory = realpathSync(join(sources, 'supplemental'));
  if (relative(keptRoot, keptDirectory) !== 'supplemental') {
    throw new SourceIntegrityError('supplemental source destination escapes its cache folder');
  }
  const inputs = [
    ...parsed.files,
    {
      path: manifest,
      sha256: createHash('sha256').update(inventoryBytes).digest('hex'),
      origin: 'recipe-generated:source-inventory',
      kind: 'metadata' as const,
      repository: 'source-inventory',
      filename: manifest,
    },
  ];
  return inputs.map(({ path, ...record }) => {
    const downloaded = sourceFile(root, path);
    if (sha256(downloaded) !== record.sha256) {
      throw new SourceIntegrityError(`supplemental source checksum mismatch: ${path}`);
    }
    const file = `supplemental/${record.sha256}`;
    if (existsSync(join(sources, file))) {
      sourceFile(keptRoot, file);
    }
    keepSource(sources, file, downloaded);
    if (sha256(join(sources, file)) !== record.sha256) {
      throw new SourceIntegrityError(`stored supplemental source checksum mismatch: ${path}`);
    }
    return { ...record, file };
  });
}
