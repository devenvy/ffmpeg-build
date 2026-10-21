import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { keptFiles } from '../src/build/fetch.ts';
import { keepSupplementalSources } from '../src/build/supplemental-sources.ts';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'ffb-inputs-'));
  folders.push(root);
  const src = join(root, 'src');
  const sources = join(root, 'sources');
  mkdirSync(src);
  mkdirSync(sources);
  const bytes = 'upstream source archive';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(src, 'source.tar'), bytes);
  const entry = {
    path: 'source.tar',
    sha256,
    origin: 'https://example.org/source.tar',
    kind: 'source',
    repository: 'upstream',
    filename: 'source.tar',
  };
  const manifest = (files = [entry]) =>
    writeFileSync(join(src, 'inputs.json'), JSON.stringify({ version: 1, files }));
  manifest();
  return { root, src, sources, sha256, entry, manifest };
};

describe('supplemental source preservation', () => {
  it('keeps verified bytes with provenance and includes them in the shared source-file inventory', () => {
    const { src, sources, sha256 } = setup();
    const records = keepSupplementalSources(src, sources, 'inputs.json');
    const input = records.find((record) => record.kind === 'source')!;
    expect(input).toMatchObject({
      sha256,
      origin: 'https://example.org/source.tar',
      repository: 'upstream',
      filename: 'source.tar',
    });
    expect(readFileSync(join(sources, input.file), 'utf8')).toBe('upstream source archive');
    expect(keptFiles({ file: 'primary.tar', sha256, supplementalSources: records })).toContainEqual(
      { file: input.file, sha256 },
    );
  });

  it('rejects a checksum mismatch and a corrupted previously stored copy', () => {
    const { src, sources, manifest, entry } = setup();
    manifest([{ ...entry, sha256: '0'.repeat(64) }]);
    expect(() => keepSupplementalSources(src, sources, 'inputs.json')).toThrow(/checksum/i);
    manifest();
    const records = keepSupplementalSources(src, sources, 'inputs.json');
    writeFileSync(
      join(sources, records.find((record) => record.kind === 'source')!.file),
      'corrupt',
    );
    expect(() => keepSupplementalSources(src, sources, 'inputs.json')).toThrow(/differs/);
  });

  it.each(['../outside.tar', '/outside.tar', 'C:/outside.tar', '\\\\host\\share\\outside.tar'])(
    'rejects unsafe input path %s',
    (path) => {
      const { src, sources, manifest, entry } = setup();
      manifest([{ ...entry, path }]);
      expect(() => keepSupplementalSources(src, sources, 'inputs.json')).toThrow(/path/);
    },
  );

  it('rejects a directory and a symlink escaping the source root', () => {
    const { root, src, sources, manifest, entry } = setup();
    mkdirSync(join(src, 'folder'));
    manifest([{ ...entry, path: 'folder' }]);
    expect(() => keepSupplementalSources(src, sources, 'inputs.json')).toThrow(/regular file/);
    symlinkSync(root, join(src, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    manifest([{ ...entry, path: 'escape/src/source.tar' }]);
    // This resolves back inside src and is safe; the actual escaping target is outside it.
    writeFileSync(join(root, 'outside.tar'), 'upstream source archive');
    manifest([{ ...entry, path: 'escape/outside.tar' }]);
    expect(() => keepSupplementalSources(src, sources, 'inputs.json')).toThrow(/regular file/);
  });

  it('deduplicates bytes without losing different repository origins', () => {
    const { src, sources, manifest, entry } = setup();
    manifest([
      entry,
      { ...entry, origin: 'https://mirror.example.org/source.tar', repository: 'other' },
    ]);
    const records = keepSupplementalSources(src, sources, 'inputs.json').filter(
      (record) => record.kind === 'source',
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.file).toBe(records[1]!.file);
    expect(records[0]!.origin).not.toBe(records[1]!.origin);
  });
});
