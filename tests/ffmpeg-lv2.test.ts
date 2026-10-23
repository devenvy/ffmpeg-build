import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixLv2FeatureTermination } from '../src/build/ffmpeg-lv2.ts';

// Actual construction shared by FFmpeg 8.1.3 and 9.0.2; upstream 4f09194 adds the sentinel.
const affected = `    const LV2_Feature *features[5];
    float *mins;

    s->features[0] = &s->map_feature;
    s->features[1] = &s->unmap_feature;
    s->features[2] = &buf_size_features[0];
    s->features[3] = &buf_size_features[1];
    s->features[4] = &buf_size_features[2];
`;
const fixed = `${affected.replace('features[5];', 'features[6];')}    s->features[5] = NULL;\n`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function source(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-lv2-features-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'libavfilter'));
  const path = join(dir, 'libavfilter', 'af_lv2.c');
  writeFileSync(path, text);
  return { dir, path };
}

it('backports the exact upstream array bound and NULL terminator together', () => {
  const { dir, path } = source(affected);
  expect(fixLv2FeatureTermination(dir, ['--enable-lv2'])).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(fixed);
  expect(fixLv2FeatureTermination(dir, ['--enable-lv2'])).toBe(false);
});

it('leaves already-fixed sources and unrelated bytes unchanged', () => {
  const text = `/* header */\n${fixed}\n/* tail */\n`;
  const { dir, path } = source(text);
  expect(fixLv2FeatureTermination(dir, ['--enable-lv2'])).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(text);
});

it('does not read or change sources when LV2 is not selected', () => {
  const { dir, path } = source(affected);
  expect(fixLv2FeatureTermination(dir, ['--enable-librsvg'])).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(affected);
  expect(fixLv2FeatureTermination('/missing/source', [])).toBe(false);
});

it.each([
  affected.replace('features[5];', 'features[6];'),
  `${affected}    s->features[5] = NULL;\n`,
  affected.replace('features[5];', 'features[7];'),
  affected.replace('&buf_size_features[2]', '&some_new_feature'),
])('rejects partial or changed constructions before writing source', (text) => {
  const { dir, path } = source(text);
  expect(() => fixLv2FeatureTermination(dir, ['--enable-lv2'])).toThrow(/LV2.*unrecognized/);
  expect(readFileSync(path, 'utf8')).toBe(text);
});
