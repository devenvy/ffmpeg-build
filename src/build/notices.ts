import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { SourceRecord } from './fetch.ts';
import type { BuildContext } from './library.ts';

const RULE = '================================================================================';
const section = (name: string) => `\n${RULE}\n${name}\n${RULE}\n\n`;

function text(heading: string, contents: string): string {
  return `--- ${heading} ---\n\n${contents}${contents.endsWith('\n') ? '' : '\n'}\n`;
}

function configuration(config: string): string {
  const value = /^#define FFMPEG_CONFIGURATION "(.*)"$/m.exec(config)?.[1];
  if (value === undefined) {
    return '';
  }
  return value.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

function requiredFile(path: string, message: string): string {
  if (!existsSync(path)) {
    throw new Error(message);
  }
  return readFileSync(path, 'utf8');
}

function expandVariables(value: string, env: NodeJS.ProcessEnv, setup: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const replacement = env[name];
    if (!replacement) {
      throw new Error(
        `${name} isn't set by the ${setup} toolchain, but platforms.yml names it in ${value}`,
      );
    }
    return replacement;
  });
}

export function writeNotices(
  context: BuildContext,
  ffmpegDir: string,
  records: readonly SourceRecord[],
  out: string,
): void {
  const plan = context.buildPlan;
  const ffmpeg = plan.ffmpeg!;
  let result = plan.notices.header;
  const configPath = join(ffmpegDir, 'config.h');
  const config = requiredFile(
    configPath,
    "FFmpeg's config.h is missing; THIRD-PARTY-NOTICES.txt names its configure line",
  );
  result += section('BUILD');
  result += `FFmpeg configure line (as ffmpeg -buildconf prints it):\n  ${configuration(config)}\n\n${plan.notices.build}`;
  result += section('SOURCE') + plan.notices.source;
  result += section('FFMPEG');
  result += `FFmpeg ${ffmpeg.version}: its LICENSE.md and CREDITS, then the license texts that govern this build, in full.\n\n`;
  for (const file of ['LICENSE.md', 'CREDITS', ...plan.notices.governing]) {
    result += text(
      file,
      requiredFile(
        join(ffmpegDir, file),
        `FFmpeg's source has no ${file} for THIRD-PARTY-NOTICES.txt`,
      ),
    );
  }
  result += section('COMPONENTS');
  result +=
    'Each library built into this build: its licence, where its source comes from (upstream, at the exact version and\ncommit), and every licence file it ships, in full.\n\n';
  for (const library of [...plan.libraries].sort((a, b) => a.name.localeCompare(b.name))) {
    const record = records.find((item) => item.name === library.name);
    if (!record) {
      throw new Error(`${library.name} has no source record for THIRD-PARTY-NOTICES.txt`);
    }
    result += `== ${library.name} ${library.version} ==\n\nLicense: ${library.license}\nOrigin: ${record.origin}\n`;
    if (record.commit) {
      result += `Commit: ${record.commit}\n`;
    }
    result += `Source: ${record.file} (sha256 ${record.sha256})\n\n`;
    for (const file of library.licenseFiles) {
      const path = join(context.depsDir, 'share', 'ffmpeg-build', 'legal', library.name, file.path);
      result += text(
        file.path,
        requiredFile(
          path,
          `${library.name}'s licence file ${file.path} isn't in ${join(context.depsDir, 'share', 'ffmpeg-build', 'legal', library.name)}`,
        ),
      );
    }
  }
  if (plan.patches.length) {
    result += section('PATCH SETS');
    result += 'The patch sets applied to FFmpeg, with their licence and licence texts.\n\n';
    for (const patch of plan.patches) {
      result += `== ${patch.name} ==\n\nLicense: ${patch.license}\nsha256: ${patch.sha256}\nPatches: ${patch.files.length ? patch.files.map((file) => file.name).join(', ') : 'none for this FFmpeg version'}\n\n`;
      for (const license of patch.licenses) {
        result += text(license.path, license.text);
      }
    }
  }
  if (plan.ships.length) {
    result += section('FILES THE PLATFORM SHIPS');
    result +=
      "Parts of the platform's toolchain that the archives carry or link in, each with its licence and notice.\n\n";
    for (const shipped of plan.ships) {
      const path = expandVariables(shipped.notice, context.env, plan.setup);
      result += `== ${shipped.file} ==\n\nLicense: ${shipped.license}\n\n`;
      result += text(
        basename(path),
        requiredFile(
          path,
          `${path}, the notice platforms.yml names for ${shipped.file}, is missing`,
        ),
      );
    }
  }
  writeFileSync(out, result);
}

export function checkNotices(path: string, context: BuildContext): void {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing`);
  }
  const contents = readFileSync(path, 'utf8');
  const missing = [...context.buildPlan.notices.governing, 'LICENSE.md', 'CREDITS'].filter(
    (file) => !contents.split(/\r?\n/).includes(`--- ${file} ---`),
  );
  for (const library of context.buildPlan.libraries) {
    if (!contents.includes(`\n== ${library.name} ${library.version} ==\n`)) {
      missing.push(`${library.name} ${library.version}`);
    }
  }
  if (!contents.startsWith(`FFmpeg ${context.buildPlan.ffmpeg!.version} — `)) {
    throw new Error(`${basename(path)} doesn't start with FFmpeg's header`);
  }
  if (missing.length) {
    throw new Error(`${basename(path)} lacks: ${missing.join(' ')}`);
  }
}
