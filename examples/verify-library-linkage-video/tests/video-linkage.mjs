import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-video-linkage-'));
const WIDTH = 128;
const HEIGHT = 128;
const FRAMES = 12;
const TIMEOUT = 120000;
const MAX_BUFFER = 8388608;
const CHANNELS = 3;
const MIN_CONTRAST = 100;
const MAX_PIXEL_ERROR = 35;
const command = (args) => {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result.stdout;
};
const source = `testsrc2=size=${WIDTH}x${HEIGHT}:rate=12:duration=1`;
const cases = [
  {
    encoder: 'libx264',
    decoder: 'h264',
    extension: 'h264',
    args: ['-preset', 'ultrafast', '-crf', '23'],
  },
  { encoder: 'libopenh264', decoder: 'h264', extension: 'h264', args: ['-b:v', '400k'] },
  // FFmpeg's existing Xvid wrapper does not advertise delayed-frame draining; require every frame with bf=0.
  { encoder: 'libxvid', decoder: 'mpeg4', extension: 'avi', args: ['-q:v', '4', '-bf', '0'] },
  {
    encoder: 'libx265',
    decoder: 'hevc',
    extension: 'hevc',
    args: ['-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1'],
  },
  {
    encoder: 'libvvenc',
    decoder: 'vvc',
    extension: 'vvc',
    format: 'yuv420p10le',
    args: ['-preset', 'fast'],
  },
  {
    encoder: 'libsvtav1',
    decoder: 'libdav1d',
    extension: 'ivf',
    args: ['-preset', '12', '-svtav1-params', 'lp=2'],
  },
];
try {
  const original = command([
    '-f',
    'lavfi',
    '-i',
    source,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(original.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
  for (const { encoder, decoder, extension, format = 'yuv420p', args } of cases) {
    const encoded = join(work, `${encoder}.${extension}`);
    command([
      '-f',
      'lavfi',
      '-i',
      source,
      '-c:v',
      encoder,
      '-threads',
      '2',
      '-pix_fmt',
      format,
      ...args,
      encoded,
    ]);
    const decoders = encoder === 'libopenh264' ? [decoder, 'libopenh264'] : [decoder];
    for (const selectedDecoder of decoders) {
      const decoded = command([
        '-c:v',
        selectedDecoder,
        '-threads',
        '2',
        '-i',
        encoded,
        '-fps_mode',
        'passthrough',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      ]);
      assert.equal(
        decoded.length,
        original.length,
        `${encoder} -> ${selectedDecoder}: frame count`,
      );
      let difference = 0;
      let minimum = 255;
      let maximum = 0;
      for (let index = 0; index < decoded.length; index++) {
        difference += Math.abs(decoded[index] - original[index]);
        minimum = Math.min(minimum, decoded[index]);
        maximum = Math.max(maximum, decoded[index]);
      }
      assert.ok(maximum - minimum > MIN_CONTRAST, `${encoder}: decoded pattern has contrast`);
      assert.ok(
        difference / decoded.length < MAX_PIXEL_ERROR,
        `${encoder}: decoded pattern retains source pixels`,
      );
      console.log(`${encoder} -> ${selectedDecoder}: ${FRAMES} frames and EOF passed`);
    }
  }
  const filenames = readdirSync(dirname(ffmpeg));
  const avcodec = filenames.find((filename) => /^libavcodec\.so\.\d+$/.test(filename));
  assert.ok(avcodec);
  const linked = spawnSync('readelf', ['-d', join(dirname(ffmpeg), avcodec)], {
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  assert.equal(linked.status, 0, linked.stderr);
  for (const name of ['x264', 'openh264', 'xvidcore', 'x265', 'vvenc', 'SvtAv1Enc']) {
    const pattern = new RegExp(`lib${name}\\.so(?:\\.|$)`);
    const bundled = filenames.some((filename) => pattern.test(filename));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(linked.stdout),
      bundled,
      `${name}: the FFmpeg dependency must match the selected static/shared mode`,
    );
  }
  for (const filename of filenames.filter((name) =>
    /^lib(openh264|x265|vvenc)\.so(?:\.|$)/.test(name),
  )) {
    const result = spawnSync('readelf', ['-d', join(dirname(ffmpeg), filename)], {
      encoding: 'utf8',
      timeout: TIMEOUT,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!/NEEDED.*libstdc\+\+/.test(result.stdout), `${filename}: private C++ runtime`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
