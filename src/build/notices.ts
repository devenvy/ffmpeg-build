import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`
    : names.join('');
}

/**
 * What a Rust library adds under its entry: the crates linked into it, then every licence text they ship, each text
 * once (most crates carry the same Apache-2.0 text), headed with every crate and file it is for. A crate reviewed to
 * ship none (cargo: standard-texts:) gets the engine's standard text of its licence, marked so.
 */
function crateNotices(context: BuildContext, library: string, record: SourceRecord): string {
  const linked = (record.crates ?? [])
    .filter((c) => c.linked)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  let result = '';
  if (linked.length) {
    result += `Rust crates compiled into ${library} (from its Cargo.lock, for this platform; each crates.io crate is in the sources\narchive as crates.io serves it, under sources/crates/):\n\n`;
    for (const c of linked) {
      result += `  ${c.name} ${c.version} (${c.license ?? ''}${c.source === 'path' ? `; part of the ${library} source` : ''})\n`;
    }
    result += '\n';
  }
  if (record.rust) {
    result += `Rust's standard library (Rust ${record.rust.version}) is linked in too: its notices are under RUST STANDARD LIBRARY below.\n\n`;
  }
  const texts = new Map<string, string[]>();
  const add = (contents: string, label: string) => {
    texts.set(contents, [...(texts.get(contents) ?? []), label]);
  };
  const legal = join(context.depsDir, 'share', 'ffmpeg-build', 'legal', library);
  for (const c of linked) {
    for (const file of c.texts) {
      add(
        requiredFile(
          join(legal, 'crates', `${c.name}-${c.version}`, file),
          `${library}'s crate ${c.name} ${c.version} has no ${file} in ${legal}`,
        ),
        `${c.name} ${c.version}: ${file}`,
      );
    }
    for (const id of c.standard ?? []) {
      const standard = context.buildPlan.cargo?.texts[id];
      if (standard === undefined) {
        throw new Error(
          `the build plan has no standard ${id} text for ${library}'s crate ${c.name} ${c.version}`,
        );
      }
      add(
        standard,
        `${c.name} ${c.version}: the standard ${id} text (the crate ships no licence file; its Cargo.toml names as authors: ${c.authors?.length ? c.authors.join(', ') : 'none'})`,
      );
    }
  }
  for (const [contents, labels] of texts) {
    result += text(labels.join('; '), contents);
  }
  return result;
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
  // the Rust standard library's notices, by text: once for every library that links that one
  const rust = new Map<string, { version: string; libraries: string[] }>();
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
    if (library.linkage) {
      result += `Linkage: ${library.linkage}\n\n`;
    }
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
    result += crateNotices(context, library.name, record);
    for (const file of record.rust?.texts ?? []) {
      const path = join(
        context.depsDir,
        'share',
        'ffmpeg-build',
        'legal',
        library.name,
        'rust',
        file,
      );
      const contents = requiredFile(
        path,
        `${library.name}'s Rust standard library notices ${file} aren't in ${dirname(path)}`,
      );
      const seen = rust.get(contents) ?? { version: record.rust!.version, libraries: [] };
      seen.libraries.push(library.name);
      rust.set(contents, seen);
    }
  }
  if (rust.size) {
    result += section('RUST STANDARD LIBRARY');
    for (const [contents, { version, libraries }] of rust) {
      result += `Rust ${version}'s standard library, linked into ${listed(libraries)}: its notices as the Rust toolchain ships them\n(COPYRIGHT-library), the licences of its own code and of every crate it is built from.\n\n`;
      result += text(`COPYRIGHT-library (Rust ${version})`, contents);
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
