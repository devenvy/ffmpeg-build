#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

import { buildFfmpeg } from './ffmpeg.ts';
import {
  type BuildContext,
  buildLibrary,
  type BuildPaths,
  prepareBuildFolders,
} from './library.ts';
import { run, step, stopChildren } from './run.ts';
import { stageBuild } from './stage.ts';
import { createToolchain } from './toolchain.ts';

import type { BuildPlan } from './plan.ts';

/** The exit status of a worker stopped by a signal: 128 plus the signal's number, as a shell reports it. */
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

function paths(): BuildPaths {
  const value = (name: string, fallback: string) => resolve(process.env[name] ?? fallback);
  return {
    plan: value('FFB_PLAN', '/plan.json'),
    recipes: value('FFB_RECIPES', '/recipes'),
    engine: value('ENGINE', '/engine'),
    cache: value('FFB_CACHE', '/cache'),
    out: value('FFB_OUT', '/out'),
    depsDir: value('DEPS_DIR', '/opt/ffmpeg-build/deps'),
    work: value('FFB_WORK', '/work'),
  };
}

function setupEnvironment(buildPaths: BuildPaths, plan: BuildPlan) {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ENGINE: buildPaths.engine,
    SETUP: plan.setup,
    BUILD_RID: plan.platform,
    DEPS_DIR: buildPaths.depsDir,
    PKG_CONFIG_PATH: join(buildPaths.depsDir, 'lib', 'pkgconfig'),
  };
  // FFB_IN=here: a native build on this machine (ffmpeg-build build --in here), with its own compilers
  return createToolchain({
    platform: plan.platform,
    setup: plan.setup,
    depsDir: buildPaths.depsDir,
    work: buildPaths.work,
    engine: buildPaths.engine,
    env: base,
    native: process.env['FFB_IN'] === 'here',
  });
}

async function main(): Promise<void> {
  const buildPaths = paths();
  const buildPlan = JSON.parse(readFileSync(buildPaths.plan, 'utf8')) as BuildPlan;
  mkdirSync(buildPaths.out, { recursive: true });
  const context: BuildContext = {
    ...buildPaths,
    buildPlan,
    sources: join(buildPaths.cache, 'sources'),
    jobs: availableParallelism(),
    toolchain: setupEnvironment(buildPaths, buildPlan),
    env: {},
  };
  context.env = context.toolchain.env;
  // every command the build runs finds the toolchain's tools first, as when the driver sourced the platform setup
  // into its shell: on a Mac that is Homebrew's GNU tar, sed and find (the cache and archives use GNU tar's options)
  if (context.env['PATH']) {
    process.env['PATH'] = context.env['PATH'];
  }
  prepareBuildFolders(context);
  const records = [];
  for (const library of buildPlan.libraries) {
    records.push(await buildLibrary(context, library));
  }
  if (!buildPlan.ffmpeg) {
    step('libraries done (this plan has no FFmpeg build)');
    return;
  }
  const ffmpeg = await buildFfmpeg(context);
  await stageBuild(context, ffmpeg.dir, ffmpeg.record, records);
}

// SIGINT/SIGTERM (from the CLI, or tini in a container): pass it to the running command and start nothing new, so the
// build fails at once and the finally below still runs; a second signal kills what is left
let stoppedBy: 'SIGINT' | 'SIGTERM' | undefined;
// stopChildren only waits for the commands to end; it has nothing to report
const ignore = (): void => undefined;
const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
  if (stoppedBy) {
    stopChildren('SIGKILL', 0).catch(ignore);
    return;
  }
  stoppedBy = signal;
  stopChildren(signal).catch(ignore);
};
process.on('SIGINT', () => {
  stop('SIGINT');
});
process.on('SIGTERM', () => {
  stop('SIGTERM');
});

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${stoppedBy ? `stopped (${stoppedBy})` : message}\n`);
  process.exitCode = stoppedBy ? SIGNAL_EXIT_CODE[stoppedBy] : 1;
} finally {
  if (process.env['FFB_HOST_UID']) {
    const gid = process.env['FFB_HOST_GID'] ?? process.env['FFB_HOST_UID'];
    try {
      await run(
        'chown',
        [
          '-R',
          `${process.env['FFB_HOST_UID']}:${gid}`,
          process.env['FFB_CACHE'] ?? '/cache',
          process.env['FFB_OUT'] ?? '/out',
        ],
        { evenWhenStopping: true },
      );
    } catch {
      // Best effort, matching the old driver's EXIT trap.
    }
  }
}
