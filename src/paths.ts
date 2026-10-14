import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: the folder holding package.json, ffmpeg/, recipes/ (works from src/ and dist/). */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Where ffmpeg/ and recipes/ are read from. FFMPEG_BUILD_DATA overrides it (tests, engine development). */
export function dataRoot(): string {
  return process.env['FFMPEG_BUILD_DATA'] ?? packageRoot;
}

export function packageVersion(): string {
  return (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
  ).version;
}

/**
 * Where editors find ffmpeg-build.yml's schema: the published file at the engine's major version tag (the schema only
 * grows within a major). It is also the schema's $id; `init` writes it into the file's yaml-language-server line.
 */
export function schemaUrl(): string {
  return `https://raw.githubusercontent.com/devenvy/ffmpeg-build/v${packageVersion().split('.')[0] ?? ''}/schema/ffmpeg-build.schema.json`;
}
