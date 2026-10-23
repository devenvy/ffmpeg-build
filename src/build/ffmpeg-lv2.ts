import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AFFECTED = '    const LV2_Feature *features[5];\n';
const FIXED = '    const LV2_Feature *features[6];\n';
const ASSIGNMENTS = `    s->features[0] = &s->map_feature;
    s->features[1] = &s->unmap_feature;
    s->features[2] = &buf_size_features[0];
    s->features[3] = &buf_size_features[1];
    s->features[4] = &buf_size_features[2];
`;
const TERMINATED = `${ASSIGNMENTS}    s->features[5] = NULL;\n`;
const once = (source: string, text: string) =>
  source.includes(text) && source.indexOf(text) === source.lastIndexOf(text);

/** Backport FFmpeg 4f09194: LV2 hosts must NULL-terminate the array of feature pointers. */
export function fixLv2FeatureTermination(dir: string, configure: readonly string[]): boolean {
  if (!configure.includes('--enable-lv2')) {
    return false;
  }
  const path = join(dir, 'libavfilter', 'af_lv2.c');
  const before = readFileSync(path, 'utf8');
  if (once(before, FIXED) && once(before, TERMINATED) && !before.includes(AFFECTED)) {
    return false;
  }
  if (!once(before, AFFECTED) || !once(before, ASSIGNMENTS) || before.includes('s->features[5]')) {
    throw new Error(
      'LV2 feature construction is unrecognized; review the upstream NULL-termination fix',
    );
  }
  writeFileSync(path, before.replace(AFFECTED, FIXED).replace(ASSIGNMENTS, TERMINATED));
  return true;
}
