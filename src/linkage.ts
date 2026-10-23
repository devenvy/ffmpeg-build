import { platformMatches } from './platforms.ts';

import type { EngineData } from './engine-data.ts';
import type { Linkage } from './schema/common.ts';
import type { Recipe } from './schema/engine.ts';

/** Platform additions follow declaration order; an explicit target choice takes precedence over these defaults. */
export function defaultLinkage(recipe: Recipe, platform: string): Linkage | undefined {
  return (
    Object.entries(recipe.linkage?.defaults ?? {})
      .filter(([pattern]) => platformMatches(platform, [pattern]))
      .at(-1)?.[1] ?? recipe.linkage?.default
  );
}

/** Mode-only FFmpeg flags, including recipes present only as dependencies. */
export function linkageConfigure(
  recipe: Recipe,
  mode: Linkage | undefined,
  platform: string,
): string[] {
  const choice = mode && recipe.linkage?.modes[mode];
  return configureForMode(choice, platform);
}

/** Every verified mode's possible flags, for configure coverage and licence-class audits. */
export function allLinkageConfigure(recipe: Recipe, platform?: string): string[] {
  return [
    ...new Set(
      Object.values(recipe.linkage?.modes ?? {}).flatMap((choice) =>
        configureForMode(choice, platform),
      ),
    ),
  ];
}

function configureForMode(
  choice: NonNullable<Recipe['linkage']>['modes'][Linkage],
  platform?: string,
): string[] {
  return choice && (!platform || !choice.platforms || platformMatches(platform, choice.platforms))
    ? (choice.configure ?? [])
        .filter(
          (entry) => !platform || !entry.platforms || platformMatches(platform, entry.platforms),
        )
        .map((entry) => entry.value)
    : [];
}

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
      const mode = overrides[name] ?? defaultLinkage(recipe, platform)!;
      const choice = recipe.linkage.modes[mode];
      if (!choice || (choice.platforms && !platformMatches(platform, choice.platforms))) {
        errors.push(`link: ${name} does not support ${mode} linking on ${platform}`);
      } else {
        modes[name] = mode;
      }
    }
  }
  for (const [name, mode] of Object.entries(modes)) {
    const requirements = data.recipes.get(name)!.linkage!.modes[mode]!['requires-link'] ?? {};
    for (const [provider, requirement] of Object.entries(requirements)) {
      if (Array.isArray(requirement) || platformMatches(platform, requirement.platforms)) {
        const allowed = Array.isArray(requirement) ? requirement : requirement.modes;
        const selected = modes[provider];
        if (!selected || !allowed.includes(selected)) {
          errors.push(
            `link: ${name} ${mode} requires ${provider} linking as ${allowed.join(' or ')} (selected ${selected ?? 'absent'})`,
          );
        }
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
