import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fetchSource, sourceRecord, type SourceRecord } from './fetch.ts';
import { fixDnnThreadLifecycle } from './ffmpeg-dnn.ts';
import { fixLv2FeatureTermination } from './ffmpeg-lv2.ts';
import { fixMetalAutorelease } from './ffmpeg-metal.ts';
import { fixTorchBackend } from './ffmpeg-torch.ts';
import { run, step } from './run.ts';
import { beforeFfmpeg } from './toolchain.ts';

import type { BuildContext } from './library.ts';

/** How much of config.log to show when configure fails: its end, where the failed test is. */
const CONFIG_LOG_TAIL_LINES = 200;

/**
 * Apple's file system is case-insensitive, and FFmpeg compiles with -I.: the VERSION file at the root of a release
 * tarball is what libc++'s `#include <version>` then finds, so none of FFmpeg's C++ sources compiles (the ocio
 * filter's; devenvy/ffmpeg-build#41). FFmpeg after 9.0 names it FF_VERSION (upstream 72e5fc4b80). Before that,
 * ffbuild/version.sh reads the version from VERSION, else from RELEASE, which in a release says the same: VERSION is
 * removed, once RELEASE is seen to agree. True when it was.
 */
export function unshadowVersionHeader(dir: string, setup: string): boolean {
  const version = join(dir, 'VERSION');
  if (!setup.startsWith('apple-') || !existsSync(version)) {
    return false;
  }
  const said = readFileSync(version, 'utf8').trim();
  const release = join(dir, 'RELEASE');
  const released = existsSync(release) ? readFileSync(release, 'utf8').trim() : '';
  if (said !== released) {
    throw new Error(
      `FFmpeg's VERSION (${said}) and RELEASE (${released || 'none'}) differ: without VERSION, which shadows libc++'s <version> on Apple, its version would be RELEASE's`,
    );
  }
  rmSync(version);
  return true;
}

/** FFmpeg 9.0.2 uses a switch-only attribute between libtls error labels; keep FFmpeg 8 and corrected sources. */
export function fixLibtlsFallthrough(dir: string, flags: readonly string[]): boolean {
  if (!flags.includes('--enable-libtls')) {
    return false;
  }
  const path = join(dir, 'libavformat', 'tls_libtls.c');
  const before = readFileSync(path, 'utf8');
  const after = before.replace(
    '    av_fallthrough;\nfail:\n',
    '    /* ffmpeg-build 2026-10-21: error labels need no switch fallthrough attribute. */\nfail:\n',
  );
  if (after === before) {
    return false;
  }
  writeFileSync(path, after);
  return true;
}

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
  if (unshadowVersionHeader(dir, context.buildPlan.setup)) {
    step("VERSION removed: it would shadow libc++'s <version> (RELEASE gives the same version)");
  }
  if (fixLibtlsFallthrough(dir, ffmpeg.configure)) {
    step('libtls: removed invalid switch fallthrough attribute between error labels');
  }
  if (fixMetalAutorelease(dir, ffmpeg.configure)) {
    step('Metal: backported upstream autorelease-pool ownership fix');
  }
  if (fixLv2FeatureTermination(dir, ffmpeg.configure)) {
    step('LV2: backported upstream feature-array NULL termination');
  }
  if (fixDnnThreadLifecycle(dir, ffmpeg.configure)) {
    step('DNN thread lifecycle corrected: only join threads after successful creation');
  }
  if (fixTorchBackend(dir, ffmpeg.configure)) {
    step('Torch: modern static probe, parameterless models and request cleanup corrected');
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
