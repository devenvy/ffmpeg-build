import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Platform text runtime library linking', () => {
  it('keeps GNU iconv static by default and bounds shared mode to verified Apple hardware', () => {
    expect(linkagePlan(data, ['libiconv'], 'osx-arm64').modes['libiconv']).toBe('static');
    expect(linkagePlan(data, ['libiconv'], 'osx-arm64', { libiconv: 'shared' }).errors).toEqual([]);
    expect(linkagePlan(data, ['libiconv'], 'win-x64', { libiconv: 'shared' }).errors).toHaveLength(
      1,
    );
  });

  it('keeps proxy gettext static outside Linux and uses native libc on Linux', () => {
    expect(linkagePlan(data, ['proxy-libintl'], 'osx-arm64').modes['proxy-libintl']).toBe('static');
    expect(
      data.recipes.get('glib')!.needs.find((need) => need.name === 'proxy-libintl')!.platforms,
    ).toEqual(['win-*', 'osx-*', 'ios-*', 'maccatalyst-*', 'android-*']);
    expect(
      linkagePlan(data, ['proxy-libintl'], 'osx-arm64', { 'proxy-libintl': 'shared' }).errors,
    ).toHaveLength(1);
  });
});
