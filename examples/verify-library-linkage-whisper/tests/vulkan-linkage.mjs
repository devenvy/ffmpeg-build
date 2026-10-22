import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 300000;
const MAX_BUFFER = 8388608;
const cpuOnly = process.env.FFB_WHISPER_CPU === '1';
const WIDTH = 64;
const HEIGHT = 64;
const CHANNELS = 3;
const FRAMES = 5;
const MAX_PIXEL_ERROR = 30;
const MODEL_BYTES = 77704715;
const MODEL_SHA256 = '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f';
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin';
const run = (args, env = {}) => {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'debug', ...args], {
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result;
};
const shared = readdirSync(dirname(ffmpeg)).some((name) => /^libvulkan\.so/.test(name));
const loader = (debug) => {
  if (shared) {
    assert.match(debug, /calling init: \/runtime\/libvulkan\.so/);
  } else {
    assert.doesNotMatch(debug, /calling init: .*\/libvulkan\.so/);
  }
};
const hardware = run(['-hwaccels']).stdout.toString();
const hasVulkan = /\bvulkan\b/.test(hardware);
if (hasVulkan) {
  const source = ['-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=5:duration=1'];
  const output = ['-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'];
  const reference = run([
    ...source,
    '-vf',
    `scale=${WIDTH}:${HEIGHT}:flags=bilinear`,
    ...output,
  ]).stdout;
  const result = run(
    [
      '-init_hw_device',
      'vulkan=vk:0',
      '-filter_hw_device',
      'vk',
      ...source,
      '-vf',
      `format=yuv420p,hwupload,libplacebo=w=${WIDTH}:h=${HEIGHT}:deband=0:peak_detect=0,hwdownload,format=yuv420p`,
      ...output,
    ],
    { LD_DEBUG: 'libs' },
  );
  assert.equal(reference.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
  assert.equal(result.stdout.length, reference.length);
  let difference = 0;
  for (let index = 0; index < reference.length; index++) {
    difference += Math.abs(reference[index] - result.stdout[index]);
  }
  assert.ok(difference / reference.length < MAX_PIXEL_ERROR);
  const debug = result.stderr.toString();
  loader(debug);
  assert.match(debug, /llvmpipe|lavapipe/i);
  console.log(
    `Vulkan -> libplacebo -> CPU: frames, pixels and ${shared ? 'shared' : 'static'} loader passed`,
  );
}
const filters = run(['-filters']).stdout.toString();
if (/\bwhisper\b/.test(filters)) {
  const work = mkdtempSync(join(tmpdir(), 'ffb-whisper-vulkan-'));
  try {
    let model;
    if (process.env.FFB_WHISPER_MODEL) {
      model = readFileSync(process.env.FFB_WHISPER_MODEL);
    } else {
      const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(TIMEOUT) });
      assert.ok(response.ok, `Whisper test model download: ${response.status}`);
      model = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(model.length, MODEL_BYTES);
    assert.equal(createHash('sha256').update(model).digest('hex'), MODEL_SHA256);
    const path = join(work, 'ggml-tiny.en.bin');
    writeFileSync(path, model);
    const video = hasVulkan
      ? [
          '-init_hw_device',
          'vulkan=vk:0',
          '-filter_hw_device',
          'vk',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=128x128:rate=5:duration=3',
        ]
      : [];
    const audio = ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=16000:duration=3'];
    const inference = `whisper=model=${path}:queue=3:use_gpu=${cpuOnly ? 0 : 1}:language=en`;
    const graph = hasVulkan
      ? [
          '-filter_complex',
          `[0:v]format=yuv420p,hwupload,libplacebo=w=64:h=64:deband=0:peak_detect=0,hwdownload,format=yuv420p[v];[1:a]${inference}[a]`,
          '-map',
          '[v]',
          '-map',
          '[a]',
        ]
      : ['-af', inference];
    const result = run([...video, ...audio, ...graph, '-f', 'null', '-'], { LD_DEBUG: 'libs' });
    const debug = result.stderr.toString();
    if (cpuOnly) {
      assert.match(debug, /whisper_init_with_params_no_state: use gpu\s+= 0/);
      assert.match(debug, /CPU total size/);
      assert.match(debug, /backends\s+= 1/);
      assert.doesNotMatch(debug, /using Vulkan0 backend/);
    } else {
      assert.match(debug, /using Vulkan0 backend/);
    }
    assert.match(debug, /run transcription at 0 ms, 48000\/48000 samples/);
    assert.match(debug, /48000 samples/);
    loader(debug);
    console.log(
      `Whisper ${cpuOnly ? 'CPU' : 'Vulkan0'} real-model inference and ${hasVulkan ? 'concurrent libplacebo' : 'Whisper-only component selection'} passed`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  assert.ok(hasVulkan, 'The target must exercise Vulkan or Whisper');
}
