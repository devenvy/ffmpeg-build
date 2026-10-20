// recipe-check's plan: where a changed recipe must build, and how. A recipe is built (without FFmpeg) on every platform
// it claims that platforms.yml builds, through an FFmpeg option whose build includes it; so is every recipe that
// builds against it (needs or uses it there), with it. The builds are nonfree: every licence may go into one, so every
// `uses` a platform allows is in, and any option is allowed.
import { CliError } from './cli-error.ts';
import { depsOn, type EngineData, knownMajors, optionRecipe, optionsOf } from './engine-data.ts';
import { expandPlatforms, platformMatches } from './platforms.ts';
import { availability, type Cell, cellBuildOrder } from './resolve.ts';
import { compareVersions } from './versions.ts';

/** The licence every check build has: the one every library may go into. */
export const CHECK_LICENSE = 'nonfree';

interface RecipeCheckTarget {
  name: string;
  platform: string;
  ffmpeg: string; // the FFmpeg major
  option: string; // the one option it builds
  only: string[]; // the checked recipes it builds (build --only), sorted
}

export interface RecipeCheckPlan {
  recipes: string[]; // the changed recipes and what builds against them, sorted
  targets: RecipeCheckTarget[]; // by platform, then name
  unbuildable: string[]; // checked recipes no platform builds
  unbuilt: { recipe: string; platforms: string[] }[]; // platforms a checked recipe claims, but nothing builds it on
}

/** A candidate build: one option on one platform, at one FFmpeg major, and the libraries it builds. */
interface Candidate {
  option: string;
  major: string;
  order: string[];
}

/** What builds against `changed` on `platform`: the recipes that need or use one of them there. */
function dependsOn(data: EngineData, recipe: string, changed: Set<string>, platform: string) {
  const r = data.recipes.get(recipe)!;
  return [...depsOn(r, 'needs', platform), ...depsOn(r, 'uses', platform)].filter(
    (d) => changed.has(d) && platformMatches(platform, data.recipes.get(d)!.platforms),
  );
}

/** Every option this cell can have that has a library there, with the libraries its build has. */
function optionBuilds(data: EngineData, cell: Cell): Candidate[] {
  return [...optionsOf(data, cell.major)]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([option, info]) => {
      const lib = optionRecipe(info, cell.platform);
      return lib && !availability(data, cell, option)
        ? [{ option, major: cell.major, order: cellBuildOrder(data, cell, [lib]).order }]
        : [];
    });
}

/**
 * The fewest builds that check every one of `wanted` (each of which some candidate fits): each time the option that
 * checks the most of what is left, then the one with the fewest libraries.
 */
function fewestBuilds(
  wanted: readonly string[],
  candidates: readonly Candidate[],
  fits: (recipe: string, c: Candidate) => boolean,
): { option: string; only: string[] }[] {
  if (!wanted.length) {
    return [];
  }
  const covers = (c: Candidate) => wanted.filter((r) => fits(r, c));
  const pick = candidates
    .filter((c) => covers(c).length)
    .sort(
      (a, b) =>
        covers(b).length - covers(a).length ||
        a.order.length - b.order.length ||
        a.option.localeCompare(b.option),
    )[0]!;
  const only = covers(pick);
  return [
    { option: pick.option, only },
    ...fewestBuilds(
      wanted.filter((r) => !only.includes(r)),
      candidates,
      fits,
    ),
  ];
}

/**
 * The plan for `changed` (recipe names). `versions` (FFmpeg major -> release, e.g. a lock's) are the releases the
 * builds use; a major without one uses its newest known release.
 */
export function recipeCheckPlan(
  data: EngineData,
  changed: readonly string[],
  versions: Record<string, string> = {},
): RecipeCheckPlan {
  const unknown = changed.filter((n) => !data.recipes.has(n));
  if (unknown.length) {
    throw new CliError(
      `there is no recipe ${unknown.join(', ')} (recipes/<name>/recipe.yml; ${[...data.recipes.keys()].join(', ')})`,
    );
  }
  const changedSet = new Set(changed);
  const platforms = [...data.platforms.keys()].sort();
  // what to build, and where: each changed recipe where it builds, and each recipe that builds against one there
  const required = new Map<string, string[]>(); // recipe -> platforms
  for (const [name, r] of data.recipes) {
    const claimed = expandPlatforms(r.platforms).filter((p) => platforms.includes(p));
    const where = changedSet.has(name)
      ? claimed
      : claimed.filter((p) => dependsOn(data, name, changedSet, p).length);
    if (where.length) {
      required.set(name, where.sort());
    }
  }
  const recipes = [...required.keys()].sort();

  // every option's build on each platform, newest FFmpeg major first
  const majors = knownMajors(data)
    .slice()
    .sort((a, b) => Number(b) - Number(a));
  const candidates = new Map<string, Candidate[]>(); // platform -> candidates
  const candidatesOn = (platform: string): Candidate[] => {
    const cached = candidates.get(platform);
    if (cached) {
      return cached;
    }
    const found = majors.flatMap((major) => {
      const version =
        versions[major] ?? [...data.ffmpeg.get(major)!.releases].sort(compareVersions).at(-1);
      return version
        ? optionBuilds(data, { series: major, major, version, license: CHECK_LICENSE, platform })
        : [];
    });
    candidates.set(platform, found);
    return found;
  };

  const targets: RecipeCheckTarget[] = [];
  const built = new Map<string, Set<string>>(); // recipe -> platforms it builds on
  for (const platform of platforms) {
    // a build checks a recipe when it has the recipe and the changed recipes it builds against there
    const fits = (recipe: string, c: Candidate) =>
      [recipe, ...dependsOn(data, recipe, changedSet, platform)].every((n) => c.order.includes(n));
    // each recipe at the newest FFmpeg major that builds it
    const byMajor = new Map<string, string[]>();
    for (const recipe of recipes.filter((r) => required.get(r)!.includes(platform))) {
      const major = candidatesOn(platform).find((c) => fits(recipe, c))?.major;
      if (major) {
        byMajor.set(major, [...(byMajor.get(major) ?? []), recipe]);
        built.set(recipe, (built.get(recipe) ?? new Set<string>()).add(platform));
      }
    }
    for (const [major, wanted] of byMajor) {
      const options = candidatesOn(platform).filter((c) => c.major === major);
      for (const { option, only } of fewestBuilds(wanted, options, fits)) {
        targets.push({
          name: `${platform}-${option}${major === majors[0] ? '' : `-ffmpeg${major}`}`,
          platform,
          ffmpeg: major,
          option,
          only,
        });
      }
    }
  }
  targets.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  const unbuildable = recipes.filter((r) => !built.has(r));
  const unbuilt = recipes
    .filter((r) => built.has(r))
    .flatMap((recipe) => {
      const missing = required.get(recipe)!.filter((p) => !built.get(recipe)!.has(p));
      return missing.length ? [{ recipe, platforms: missing }] : [];
    });
  return { recipes, targets, unbuildable, unbuilt };
}
