// The nightly FFmpeg support check: node scripts/ffmpeg-support.ts [--write] [--report <file>]
// Reads FFmpeg's release tags and the configure script of each handled major's newest release (and the one before it),
// corrects ffmpeg/<major>.yml's releases and writes ffmpeg/components/<major>.yml (the components of each major's newest
// release, their runtime names and what each needs of configure's options, from its sources at its tag) with --write,
// and writes a report of what a person must decide.
// Exit 2 when upstream can't be read or the data can't be corrected.
import { writeFileSync } from 'node:fs';

import { EXIT_USAGE } from '../src/cli-error.ts';
import { ffmpegVersionSource, loadEngineData } from '../src/engine-data.ts';
import {
  COMPONENT_FILES,
  componentsFromSources,
  type ComponentsRead,
  isNameSource,
} from '../src/ffmpeg-components.ts';
import {
  type LicenseClass,
  parseConfigure,
  supportCheck,
  SupportError,
} from '../src/ffmpeg-support.ts';
import { packageRoot } from '../src/paths.ts';
import { readTarGz } from '../src/untar.ts';
import { findVersions, GitMissingError, UpstreamError } from '../src/upstream.ts';

/** process.argv's first two are node and this script. */
const FIRST_ARG = 2;

const args = process.argv.slice(FIRST_ARG);
const write = args.includes('--write');
const reportAt = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;

async function configureOf(version: string): Promise<Map<string, LicenseClass>> {
  const url = `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n${version}/configure`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new SupportError(`FFmpeg ${version}'s configure: ${url} answered ${res.status}`);
  }
  return parseConfigure(await res.text());
}

// The runtime names are read from every source file of FFmpeg's libraries: the tag's archive, in one download, rather
// than a few thousand files one by one.
async function componentsOf(version: string): Promise<ComponentsRead> {
  const url = `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n${version}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new SupportError(`FFmpeg ${version}'s sources: ${url} answered ${res.status}`);
  }
  const files = new Map<string, string>();
  for (const entry of readTarGz(Buffer.from(await res.arrayBuffer()))) {
    // FFmpeg-n9.0.2/libavcodec/allcodecs.c -> libavcodec/allcodecs.c
    const path = entry.name.slice(entry.name.indexOf('/') + 1);
    const wanted = path === 'configure' || COMPONENT_FILES.includes(path) || isNameSource(path);
    if (entry.type === 'file' && wanted) {
      files.set(path, entry.data.toString('utf8'));
    }
  }
  const configure = files.get('configure');
  if (configure === undefined) {
    throw new SupportError(`FFmpeg ${version}'s sources: ${url} has no configure`);
  }
  return componentsFromSources(files, new Set(parseConfigure(configure).keys()));
}

try {
  const data = loadEngineData(packageRoot);
  const found = await findVersions(ffmpegVersionSource(data), 'FFmpeg');
  const upstream = ('versions' in found ? found.versions : []).filter((v) =>
    /^\d+\.\d+(\.\d+)?$/.test(v),
  );
  const text = await supportCheck({
    data,
    dataRoot: packageRoot,
    upstream,
    configureOf,
    componentsOf,
    write,
  });
  if (reportAt) {
    writeFileSync(reportAt, text);
  }
  process.stdout.write(text);
} catch (e) {
  if (!(e instanceof SupportError || e instanceof UpstreamError || e instanceof GitMissingError)) {
    throw e;
  }
  process.stderr.write(`ffmpeg-support: ${e.message}\n`);
  process.exit(EXIT_USAGE);
}
