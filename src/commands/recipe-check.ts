// `ffmpeg-build recipe-check <recipes>`: build changed recipes (and what builds against them) on every platform they
// claim, without FFmpeg. It writes a throwaway folder (ffmpeg-build.yml with one target per platform and option, and
// ffmpeg.lock seeded from the canary's lock, so the versions are the ones CI builds), then builds each target with
// --only. CI plans once (--plan --json: the matrix, one job per platform) and each job builds its platform from the
// same folder, so every job builds the same versions.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { type BuildIn, defaultIn } from '../build-settings.ts';
import { CliError, EXIT_PROBLEM } from '../cli-error.ts';
import { LOCK_FILE, parseFolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { platformMatches } from '../platforms.ts';
import { readFileIfPresent } from '../read-file.ts';
import { CHECK_LICENSE, recipeCheckPlan, type RecipeCheckPlan } from '../recipe-check.ts';
import { runnerOf } from '../release.ts';
import { defaultPinSource, type PinSource } from '../source-pins.ts';
import { type Folder, FOLDER_FILE, loadFolder } from '../targets.ts';
import { JSON_INDENT } from '../text.ts';
import { cacheRoot, runTargetBuild } from './build.ts';
import { runFolderLockOrUpdate } from './folder-versions.ts';
import { type Fetch, upstreamFetcher } from './versions.ts';

import type { EngineData } from '../engine-data.ts';

interface Result {
  output: string;
  exitCode: number;
  notes?: string[];
}

/** What recipe-check writes beside the folder: the recipes it is for, and its plan. */
const PLAN_FILE = 'recipe-check.json';

/** The lock the versions come from when none is named: the engine's canary, which CI keeps building. */
const CANARY_LOCK = join(packageRoot, 'examples', 'canary', LOCK_FILE);

export interface RecipeCheckOptions {
  plan?: boolean; // write the folder and say what would build where, without building
  json?: boolean;
  platform?: string; // only these platforms (comma-separated patterns)
  lock?: string; // the lock whose versions to build (default: the canary's, when the engine has it)
  dir?: string; // the folder to write (default: a new temporary one); one already written for the same recipes is reused
  out?: string;
  in?: BuildIn;
  dryRun?: boolean;
}

/** One CI job: a platform, where it builds, and its targets. */
interface PlatformJob {
  platform: string;
  runner: string;
  in: BuildIn;
  targets: { name: string; only: string[] }[];
}

const folderText = (recipes: readonly string[], plan: RecipeCheckPlan): string =>
  [
    `# Written by \`ffmpeg-build recipe-check ${recipes.join(' ')}\`: a throwaway folder whose targets build those`,
    `# recipes (and what builds against them) without FFmpeg. ${CHECK_LICENSE}, so every library may go in.`,
    'targets:',
    ...plan.targets.map(
      (t) =>
        `  ${t.name}: { platform: ${t.platform}, license: ${CHECK_LICENSE}, ffmpeg: '${t.ffmpeg}', with: [${t.option}] }`,
    ),
    '',
  ].join('\n');

/** The folder recipe-check builds from: `dir`'s, when it was written for these recipes; else written and locked. */
async function checkFolder(
  data: EngineData,
  recipes: string[],
  options: RecipeCheckOptions,
  lookups: { fetch?: Fetch; pinSource?: PinSource },
): Promise<{ folder: Folder; plan: RecipeCheckPlan; dir: string }> {
  const dir = resolve(options.dir ?? mkdtempSync(join(tmpdir(), 'ffmpeg-build-recipe-check-')));
  const planFile = join(dir, PLAN_FILE);
  const text = readFileIfPresent(planFile);
  const written = text
    ? (JSON.parse(text) as { recipes: string[]; plan: RecipeCheckPlan })
    : undefined;
  let plan: RecipeCheckPlan;
  if (written && JSON.stringify(written.recipes) === JSON.stringify(recipes)) {
    plan = written.plan;
  } else {
    const seedPath = options.lock ?? CANARY_LOCK;
    const seedText = readFileIfPresent(seedPath);
    if (options.lock && seedText === undefined) {
      throw new CliError(`--lock ${seedPath}: no such file`);
    }
    const seed = seedText === undefined ? undefined : parseFolderLock(seedText, seedPath);
    plan = recipeCheckPlan(data, recipes, seed?.ffmpeg ?? {});
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FOLDER_FILE), folderText(recipes, plan));
    if (seedText !== undefined) {
      writeFileSync(join(dir, LOCK_FILE), seedText);
    }
    if (plan.targets.length) {
      const locked = await runFolderLockOrUpdate(
        openCheckFolder(dir),
        data,
        { mode: 'keep' },
        lookups.fetch ?? upstreamFetcher(data),
        lookups.pinSource ?? defaultPinSource(join(cacheRoot(), 'sources')),
      );
      if (locked.exitCode) {
        throw new CliError(locked.output, EXIT_PROBLEM);
      }
    }
    writeFileSync(planFile, `${JSON.stringify({ recipes, plan }, null, JSON_INDENT)}\n`);
  }
  return { folder: openCheckFolder(dir), plan, dir };
}

function openCheckFolder(dir: string): Folder {
  const r = loadFolder(dir);
  if (!r.ok) {
    throw new CliError(
      [`${join(dir, FOLDER_FILE)}:`, ...r.errors.map((e) => `  ✗ ${e}`)].join('\n'),
    );
  }
  return { ...r.folder, libraryOnly: true };
}

/** The problems that fail the check: platforms a recipe claims that nothing builds it on. */
const unbuiltLines = (plan: RecipeCheckPlan): string[] =>
  plan.unbuilt.map(
    (u) =>
      `${u.recipe} claims ${u.platforms.join(', ')}, but no option builds it there: correct its platforms: in recipes/${u.recipe}/recipe.yml, or the option's in ffmpeg/<major>.yml`,
  );
const unbuildableLines = (plan: RecipeCheckPlan): string[] =>
  plan.unbuildable.map((r) => `no option builds ${r} on any platform, so nothing checks it here`);

export async function runRecipeCheck(
  data: EngineData,
  names: readonly string[],
  options: RecipeCheckOptions,
  lookups: { fetch?: Fetch; pinSource?: PinSource } = {},
): Promise<Result> {
  const recipes = [...new Set(names)].sort();
  if (!recipes.length) {
    throw new CliError('name the recipes to check, e.g. `ffmpeg-build recipe-check zlib`');
  }
  const { folder, plan, dir } = await checkFolder(data, recipes, options, lookups);
  const patterns = options.platform
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const targets = plan.targets.filter((t) => !patterns || platformMatches(t.platform, patterns));
  const failed = plan.unbuilt.length ? EXIT_PROBLEM : 0;
  if (options.plan) {
    const jobs: PlatformJob[] = [];
    for (const t of targets) {
      let job = jobs.find((j) => j.platform === t.platform);
      if (!job) {
        job = {
          platform: t.platform,
          runner: runnerOf(data, t.platform),
          in: defaultIn(t.platform),
          targets: [],
        };
        jobs.push(job);
      }
      job.targets.push({ name: t.name, only: t.only });
    }
    if (options.json) {
      const body = {
        recipes: plan.recipes,
        dir,
        unbuildable: plan.unbuildable,
        unbuilt: plan.unbuilt,
        platforms: jobs,
      };
      return { output: JSON.stringify(body, null, JSON_INDENT), exitCode: failed };
    }
    const lines = [
      `${dir}: checks ${plan.recipes.join(', ')}`,
      ...jobs.map(
        (j) =>
          `  ${j.platform} (${j.in} on ${j.runner}): ${j.targets.map((t) => `${t.name} builds ${t.only.join(', ')}`).join('; ')}`,
      ),
      ...unbuiltLines(plan).map((l) => `✗ ${l}`),
    ];
    return {
      output: lines.join('\n'),
      exitCode: failed,
      notes: unbuildableLines(plan).map((l) => `note: ${l}`),
    };
  }
  // every target, whatever fails: one broken platform shouldn't hide another
  const outputs: string[] = [];
  const failures: string[] = [];
  for (const t of targets) {
    try {
      const r = await runTargetBuild(folder, t.name, data, {
        out: options.out ?? join(dir, 'dist'),
        only: t.only,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.in ? { in: options.in } : {}),
      });
      outputs.push(`${t.name}: ${r.output}`);
      if (r.exitCode) {
        failures.push(t.name);
      }
    } catch (e) {
      if (!(e instanceof CliError)) {
        throw e;
      }
      outputs.push(`✗ ${t.name}: ${e.message}`);
      failures.push(t.name);
    }
  }
  const problems = [
    ...(failures.length
      ? [`${failures.length} of ${targets.length} failed: ${failures.join(', ')}`]
      : []),
    ...unbuiltLines(plan),
  ];
  return {
    output: [...outputs, ...problems.map((p) => `✗ ${p}`)].join('\n'),
    exitCode: failures.length ? EXIT_PROBLEM : failed,
    notes: unbuildableLines(plan).map((l) => `note: ${l}`),
  };
}
