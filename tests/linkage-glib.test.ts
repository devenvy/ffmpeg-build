import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['glib', 'pcre2', 'libffi'];

describe('GLib dependency linking choices', () => {
  it('keeps static defaults and permits independent Linux x64 shared selections', () => {
    for (const library of libraries) {
      expect(linkagePlan(data, libraries, 'linux-x64').modes[library]).toBe('static');
      const plan = linkagePlan(data, libraries, 'linux-x64', { [library]: 'shared' });
      expect(plan.errors).toEqual([]);
      expect(plan.modes[library]).toBe('shared');
      expect(
        linkagePlan(data, libraries, 'linux-arm64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });
});
