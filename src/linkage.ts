import { platformMatches } from './platforms.ts';

import type { EngineData } from './engine-data.ts';
import type { Linkage } from './schema/common.ts';
import type { Recipe } from './schema/engine.ts';

/** Only a recipe's declared and verified modes may be selected; dependencies keep their own defaults. */
export function linkagePlan(
  data: EngineData,
  recipes: readonly string[],
  platform: string,
  overrides: Readonly<Record<string, Linkage>> = {},
): { modes: Record<string, Linkage>; errors: string[] } {
  const modes: Record<string, Linkage> = {};
  const errors: string[] = [];
  for (const name of Object.keys(overrides)) {
    if (!data.recipes.has(name)) {
      errors.push(`link: ${name} is not a recipe name`);
    } else if (!recipes.includes(name)) {
      errors.push(`link: ${name} is not in this build`);
    } else if (!data.recipes.get(name)!.linkage) {
      errors.push(`link: ${name} declares no selectable linking modes`);
    }
  }
  for (const name of recipes) {
    const recipe = data.recipes.get(name)!;
    if (recipe.linkage) {
      const mode = overrides[name] ?? recipe.linkage.default;
      const choice = recipe.linkage.modes[mode];
      if (!choice || (choice.platforms && !platformMatches(platform, choice.platforms))) {
        errors.push(`link: ${name} does not support ${mode} linking on ${platform}`);
      } else {
        modes[name] = mode;
      }
    }
  }
  return { modes, errors };
}

/** Resolve recipe variables and runtime files before computing build plans and caches. */
export function linkedRecipe(recipe: Recipe, mode: Linkage | undefined): Recipe {
  const choice = mode && recipe.linkage?.modes[mode];
  if (!choice) {
    return recipe;
  }
  return {
    ...recipe,
    ...(choice.runtime ? { runtime: choice.runtime } : {}),
    build: {
      ...recipe.build,
      vars: { ...recipe.build.vars, ...choice.vars },
      platforms: Object.fromEntries(
        Object.entries(recipe.build.platforms).map(([pattern, addition]) => [
          pattern,
          { ...addition, vars: { ...addition.vars, ...choice.vars } },
        ]),
      ),
    },
  };
}
