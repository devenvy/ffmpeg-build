import { z } from 'zod';

import { name, text } from './common.ts';
import { LICENSES } from './profile.ts';
import { COMPONENT_KINDS, type ComponentKind } from '../ffmpeg-components.ts';

// ffmpeg-build.yml: one per folder. Bases hold shared lists; each target is exactly one build.
const names = z.array(name, { error: 'expected a list of names, like [dav1d, opus]' }).default([]);
const pins = z
  .record(name, text, { error: 'expected library: version pairs, like { dav1d: "~1.5" }' })
  .default({});

// components: { decoders: [h264, hevc], filters: [scale] }: the kinds listed are built with only those names (and
// what the target's options and patch sets need); kinds left out keep FFmpeg's defaults
const componentNames = z.array(
  z.string().regex(/^[a-z0-9_-]+$/, { error: 'expected a component name like h264 or scale' }),
  { error: 'expected a list of component names, like [h264, hevc]' },
);
const components = z
  .strictObject(
    Object.fromEntries(COMPONENT_KINDS.map((k) => [k, componentNames.optional()])) as Record<
      ComponentKind,
      z.ZodOptional<typeof componentNames>
    >,
    { error: `expected components: by kind (${COMPONENT_KINDS.join(', ')})` },
  )
  .default({});

const SOURCE_OFFER = 'expected who to ask for the source, like an email address';

const base = z.strictObject({ with: names, without: names, pin: pins, components });

const target = z.strictObject({
  platform: text,
  license: z.enum(LICENSES, { error: `expected one of ${LICENSES.join(', ')}` }),
  ffmpeg: text,
  base: names,
  with: names,
  without: names,
  pin: pins,
  components,
  patches: z.array(text).default([]),
  tests: z.array(text).default([]),
  'release-group': name.optional(), // targets that release together (default: the folder's one group)
  'allow-removal': names, // components it may lose since the last release
});

// where and how a platform's targets build: a GitHub runs-on label (or list of labels), and in: docker | here
const buildSetting = z.strictObject({
  runner: z
    .union([text, z.array(text).min(1)], { error: 'expected a runner label, or a list of labels' })
    .optional(),
  in: z.enum(['docker', 'here'], { error: 'expected one of docker, here' }).optional(),
});

export const folderSchema = z.strictObject({
  build: z.record(text, buildSetting).default({}), // keyed by platform pattern, like linux-* or win-x64
  bases: z.record(name, base).default({}),
  pin: pins,
  notify: z
    .strictObject({
      'new-ffmpeg': z.enum(['true', 'false'], { error: 'expected true or false' }).optional(),
    })
    .optional(),
  'allow-removal': names, // components any target may lose since the last release
  // who THIRD-PARTY-NOTICES.txt's written offer names to ask for the source (none: whoever distributed the build)
  'source-offer': z
    .string({ error: SOURCE_OFFER })
    .trim()
    .min(1, { error: SOURCE_OFFER })
    .optional(),
  targets: z.record(name, target, {
    error: 'expected targets: a name for each build, with platform, license and ffmpeg',
  }),
});
