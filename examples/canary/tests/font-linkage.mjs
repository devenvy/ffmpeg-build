import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 30000;
const WIDTH = 160;
const HEIGHT = 96;
const work = mkdtempSync(join(tmpdir(), 'ffb-font-linkage-'));
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const font = join(work, 'test.ttf');
const config = join(work, 'fonts.conf');
const asset = join(dirname(fileURLToPath(import.meta.url)), 'font.base64');
const render = (filter) => {
  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      `color=black:size=${WIDTH}x${HEIGHT}:rate=1`,
      '-vf',
      filter,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-',
    ],
    {
      env: { ...process.env, FONTCONFIG_FILE: config },
      timeout: TIMEOUT,
    },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(result.stdout.length, WIDTH * HEIGHT);
  assert.ok(
    result.stdout.some((value) => value !== 0),
    'the authored font must render visible glyphs',
  );
  return result.stdout;
};
try {
  writeFileSync(font, Buffer.from(readFileSync(asset, 'utf8').trim(), 'base64'));
  writeFileSync(
    config,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir>${work}</dir><cachedir>${work}/cache</cachedir></fontconfig>`,
  );
  const style = ':text=FFB:fontsize=32:fontcolor=white:x=8:y=8';
  const direct = render(`drawtext=fontfile=${font}${style}`);
  const discovered = render(`drawtext=font='FFB Test'${style}`);
  assert.deepEqual(discovered, direct, 'fontconfig must discover the same authored font by name');
  const bidi = `drawtext=fontfile=${font}:text='F אב B':fontsize=32:fontcolor=white:x=8:y=8`;
  assert.notDeepEqual(
    render(`${bidi}:text_shaping=1`),
    render(`${bidi}:text_shaping=0`),
    'FriBidi must reorder the mixed-direction text',
  );
  const subtitles = join(work, 'test.ass');
  writeFileSync(
    subtitles,
    `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 96
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,FFB Test,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,FFB
`,
  );
  render(`ass=filename=${subtitles}:fontsdir=${work}`);
  const libraries = readdirSync(dirname(ffmpeg)).filter((name) =>
    /^lib(?:ass|harfbuzz|freetype|png|fontconfig|expat|fribidi).*\.so/.test(name),
  );
  if (libraries.length) {
    const dynamic = spawnSync(
      'readelf',
      ['-d', ...libraries.map((name) => join(dirname(ffmpeg), name))],
      {
        encoding: 'utf8',
        timeout: TIMEOUT,
      },
    );
    assert.equal(dynamic.status, 0, dynamic.stderr);
    assert.doesNotMatch(
      dynamic.stdout,
      /NEEDED.*(?:libstdc\+\+|libgcc_s)/,
      'the bundled font libraries must keep compiler runtimes private',
    );
  }
  console.log(
    'Authored font: direct rendering, fontconfig discovery, bidi shaping and ASS subtitles passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
