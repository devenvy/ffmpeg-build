import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';
import { addTo, missingByTarget, removeFrom } from '../src/folder-edit.ts';
import { loadFolder } from '../src/targets.ts';

const TEXT = [
  '# my builds',
  'bases:',
  '  common: { with: [dav1d, opus] }   # everyone',
  '  gpl:',
  '    with: [x265]',
  'targets:',
  '  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common, gpl] }',
  '  b:',
  '    platform: win-x64',
  '    license: lgplv3',
  '    ffmpeg: 9',
  '    base: [common]',
  '',
].join('\n');

function folderOf(text: string) {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-edit-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), text);
  const r = loadFolder(d);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
}
const target = (text: string, name: string) => folderOf(text).targets.find((t) => t.name === name)!;

describe('editing bases and targets in place', () => {
  it('adds to a base (flow map) and every target using it gets it; comments stay', () => {
    const after = addTo(TEXT, 'common', ['srt']);
    expect(after).toContain('  common: { with: [dav1d, opus, srt] }   # everyone');
    expect(after).toContain('# my builds');
    expect(target(after, 'a').with).toContain('srt');
    expect(target(after, 'b').with).toContain('srt');
  });

  it('adds to a target (block map) that has no with: yet', () => {
    const after = addTo(TEXT, 'b', ['nvenc']);
    expect(after).toContain('    base: [common]\n    with: [nvenc]\n');
    expect(target(after, 'b').with).toContain('nvenc');
  });

  it('adds to a flow-map target that has no with: yet', () => {
    const after = addTo(TEXT, 'a', ['vaapi']);
    expect(after).toContain(
      '  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common, gpl], with: [vaapi] }',
    );
  });

  it('adding what a target turns down takes it out of its without:', () => {
    const declined = TEXT.replace(
      'base: [common, gpl] }',
      'base: [common, gpl], without: [opus] }',
    );
    const after = addTo(declined, 'a', ['opus']);
    expect(target(after, 'a').with).toContain('opus');
    expect(target(after, 'a').without).toEqual([]);
  });

  it('removes from a target what a base gives it by turning it down there', () => {
    const after = removeFrom(TEXT, 'a', ['opus']);
    expect(target(after, 'a').with).not.toContain('opus');
    expect(target(after, 'a').without).toContain('opus');
    expect(target(after, 'b').with).toContain('opus'); // the base is untouched
  });

  it('removes from a base', () => {
    const after = removeFrom(TEXT, 'common', ['opus']);
    expect(after).toContain('  common: { with: [dav1d] }   # everyone');
  });

  it('names an unknown base or target', () => {
    expect(() => addTo(TEXT, 'nope', ['srt'])).toThrow(
      'there is no base or target nope in ffmpeg-build.yml',
    );
  });
});

describe('what targets could add', () => {
  it('lists, per option, the targets that could build it but do not list or turn it down', () => {
    const found = missingByTarget(folderOf(TEXT), fixtureData());
    expect(found.get('srt')).toEqual(['a', 'b']);
    expect(found.get('vaapi')).toEqual(['a']); // win-x64 has no vaapi
    expect(found.has('opus')).toBe(false); // both have it
    expect(found.has('x265')).toBe(false); // a has it; b is lgplv3, which x265 isn't allowed in
  });

  it('suggests no second member of a one-per-build group (another TLS library) to a target that has one', () => {
    // without a TLS library, a could take either
    expect(missingByTarget(folderOf(TEXT), fixtureData()).get('gnutls')).toEqual(['a']);
    const found = missingByTarget(
      folderOf(TEXT.replace('with: [x265]', 'with: [x265, openssl]')),
      fixtureData(),
    );
    expect(found.has('gnutls')).toBe(false);
    expect(found.has('openssl')).toBe(false);
  });

  it('the CLI edits the file and sums up every affected target', () => {
    const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-edit-cli-'));
    writeFileSync(join(d, 'ffmpeg-build.yml'), TEXT);
    const r = runCli(['profile', 'add', 'srt', '--to', 'common'], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(r.stdout).toContain('added srt to common');
    expect(r.stdout).toMatch(/^[✓-] target a \(linux-x64, gplv3, FFmpeg 9\)$/m);
    expect(r.stdout).not.toMatch(/^[ \t]+✓/m); // what is there isn't listed again
    expect(r.stdout.split('\n').length).toBeLessThan(20);
    expect(readFileSync(join(d, 'ffmpeg-build.yml'), 'utf8')).toContain('with: [dav1d, opus, srt]');
    const missing = runCli(['profile', 'missing'], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(missing.stdout).toContain('vaapi: a');
    expect(missing.exitCode).toBe(1);
  });

  it('refuses an edit that would give a target a problem, writing nothing and saying why', () => {
    const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-edit-refuse-'));
    writeFileSync(join(d, 'ffmpeg-build.yml'), TEXT);
    // x265 is GPL: b is lgplv3
    const r = runCli(['profile', 'add', 'x265', '--to', 'common'], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^not saved: adding x265 to common would give b a problem:$/m);
    expect(r.stdout).toMatch(/^ {2}✗ b: .*x265/m);
    expect(r.stdout).toContain('ffmpeg-build.yml is unchanged.');
    expect(readFileSync(join(d, 'ffmpeg-build.yml'), 'utf8')).toBe(TEXT);
    // to the target whose license takes it, it goes in
    const ok = runCli(['profile', 'add', 'x265', '--to', 'a'], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('added x265 to a');
  });
});
