import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fetchSource, sourceRecord, type SourceRecord } from './fetch.ts';
import { run, step } from './run.ts';
import { beforeFfmpeg } from './toolchain.ts';

import type { BuildContext } from './library.ts';

/** How much of config.log to show when configure fails: its end, where the failed test is. */
const CONFIG_LOG_TAIL_LINES = 200;

export async function buildFfmpeg(
  context: BuildContext,
): Promise<{ dir: string; record: SourceRecord }> {
  const ffmpeg = context.buildPlan.ffmpeg;
  if (!ffmpeg) {
    throw new Error('the build plan has no FFmpeg build');
  }
  step(`FFmpeg ${ffmpeg.version}`);
  const dir = join(context.work, 'ffmpeg');
  const fetched = await fetchSource(
    { archives: ffmpeg.archives, ...(ffmpeg.sha256 ? { sha256: ffmpeg.sha256 } : {}) },
    dir,
    'ffmpeg',
    context.sources,
    context.work,
  );
  const record = sourceRecord('ffmpeg', ffmpeg.version, fetched, context.sources);
  for (const set of context.buildPlan.patches) {
    for (const patch of set.files) {
      const path = join(context.work, 'patch.diff');
      writeFileSync(path, patch.text);
      step(`patch ${set.name}/${patch.name}`);
      try {
        await run('git', ['-C', dir, 'apply', '--whitespace=nowarn', '-p1', path], {
          env: { ...context.env, GIT_CEILING_DIRECTORIES: dirname(context.work) },
        });
      } catch (error) {
        throw new Error(
          `patches/${set.name}: ${patch.name} doesn't apply to FFmpeg ${ffmpeg.version}; update it for this version`,
          { cause: error },
        );
      }
    }
  }
  const install = join(context.work, 'install');
  const env = {
    ...context.env,
    ENGINE: context.engine,
    SETUP: context.buildPlan.setup,
    BUILD_RID: context.buildPlan.platform,
    DEPS_DIR: context.depsDir,
    JOBS: String(context.jobs),
    INSTALL: install,
    PKG_CONFIG_PATH: join(context.depsDir, 'lib', 'pkgconfig'),
  };
  try {
    await run(
      'bash',
      ['./configure', `--prefix=${install}`, ...beforeFfmpeg(context, dir, ffmpeg.configure)],
      { cwd: dir, env },
    );
  } catch (error) {
    const configLog = join(dir, 'ffbuild', 'config.log');
    if (existsSync(configLog)) {
      process.stderr.write(
        `${readFileSync(configLog, 'utf8').split(/\r?\n/).slice(-CONFIG_LOG_TAIL_LINES).join('\n')}\n`,
      );
    }
    throw new Error("FFmpeg's configure failed (the end of ffbuild/config.log is above)", {
      cause: error,
    });
  }
  const configHeader = join(dir, 'config.h');
  const canonical = (value: string, from: string, to: string) =>
    value.replaceAll(from, to).replaceAll(from.replaceAll('\\', '\\\\'), to);
  const rewritten = canonical(
    canonical(readFileSync(configHeader, 'utf8'), context.depsDir, '/opt/ffmpeg-build/deps'),
    context.work,
    '/work',
  )
    .replaceAll('/work\\\\', '/work/')
    .replaceAll('/opt/ffmpeg-build/deps\\\\', '/opt/ffmpeg-build/deps/');
  writeFileSync(configHeader, rewritten);
  const configured = new Set(
    readFileSync(join(dir, 'ffbuild', 'config.mak'), 'utf8').split(/\r?\n/),
  );
  const missing = ffmpeg.verify.filter((name) => !configured.has(`CONFIG_${name}=yes`));
  if (missing.length) {
    throw new Error(
      `FFmpeg's configure left out: ${missing.join(' ')} (asked for, but not enabled)`,
    );
  }
  await run('make', [`-j${context.jobs}`], { cwd: dir, env });
  await run('make', ['install'], { cwd: dir, env });
  return { dir, record };
}
