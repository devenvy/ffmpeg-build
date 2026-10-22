import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['libxau', 'libxcb', 'libx11', 'libxext', 'libxv'];

describe('X11 runtime linking choices', () => {
  it('keeps static defaults for every owner', () => {
    expect(linkagePlan(data, libraries, 'linux-x64')).toEqual({
      modes: Object.fromEntries(libraries.map((name) => [name, 'static'])),
      errors: [],
    });
  });

  it.each(libraries)('%s is selectable in a complete shared closure', (name) => {
    const shared = Object.fromEntries(libraries.map((library) => [library, 'shared'] as const));
    expect(linkagePlan(data, libraries, 'linux-x64', shared).errors).toEqual([]);
    expect(linkagePlan(data, libraries, 'linux-x64', shared).modes[name]).toBe('shared');
    expect(linkagePlan(data, libraries, 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(
      1,
    );
  });

  it.each([
    ['libxcb'],
    ['libxcb', 'libx11'],
    ['libxcb', 'libx11', 'libxext'],
    ['libxcb', 'libx11', 'libxext', 'libxv'],
    ['libxau'],
  ])('allows shared providers below static consumers: %j', (...selected) => {
    const override = Object.fromEntries(selected.map((name) => [name, 'shared'] as const));
    expect(linkagePlan(data, libraries, 'linux-x64', override).errors).toEqual([]);
  });

  it.each([
    ['libx11', 'libxcb'],
    ['libxext', 'libx11'],
    ['libxv', 'libxext'],
  ])('refuses a second hidden owner in shared %s', (owner, provider) => {
    const plan = linkagePlan(data, libraries, 'linux-x64', { [owner]: 'shared' });
    expect(plan.modes[provider]).toBe('static');
    expect(plan.errors).toContain(
      `link: ${owner} shared requires ${provider} linking as shared (selected static)`,
    );
  });
});
