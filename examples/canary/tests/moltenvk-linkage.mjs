import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

assert.equal(process.platform, 'darwin');
const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const directory = dirname(ffmpeg);
const FRAMES = 5;
const WIDTH = 64;
const HEIGHT = 64;
const CHANNELS = 3;
const MAX_PIXEL_ERROR = 30;
const TIMEOUT = 120000;
const MAX_OUTPUT = 8388608;
const shared = existsSync(join(directory, 'libMoltenVK.dylib'));
const environment = { ...process.env };
delete environment.DYLD_LIBRARY_PATH;
delete environment.VK_DRIVER_FILES;
delete environment.VK_ADD_DRIVER_FILES;
delete environment.VK_ICD_FILENAMES;
if (shared) {
  environment.VK_ICD_FILENAMES = join(directory, 'MoltenVK_icd.json');
}
function command(program, args, env = environment) {
  const result = spawnSync(program, args, {
    env,
    timeout: TIMEOUT,
    maxBuffer: MAX_OUTPUT,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  assert.equal(result.signal, null);
  return result;
}
const payload = readdirSync(directory);
assert.equal(
  payload.some((name) => /^libvulkan.*\.dylib$/.test(name)),
  shared,
);
assert.equal(existsSync(join(directory, 'MoltenVK_icd.json')), shared);
if (!shared) {
  for (const name of payload.filter((file) => /^libav.*\.dylib$/.test(file))) {
    const imports = command('otool', ['-L', join(directory, name)]).stdout.toString();
    assert.doesNotMatch(imports, /lib(?:vulkan|MoltenVK).*\.dylib/);
  }
}
const source = ['-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=5:duration=1'];
const output = ['-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'];
const reference = command(ffmpeg, [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  ...source,
  '-vf',
  `scale=${WIDTH}:${HEIGHT}:flags=bilinear`,
  ...output,
]).stdout;
const processed = command(
  ffmpeg,
  [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'verbose',
    '-init_hw_device',
    'vulkan=vk:0',
    '-filter_hw_device',
    'vk',
    ...source,
    '-vf',
    `format=yuv420p,hwupload,libplacebo=w=${WIDTH}:h=${HEIGHT}:deband=0:peak_detect=0,hwdownload,format=yuv420p`,
    ...output,
  ],
  { ...environment, DYLD_PRINT_LIBRARIES: '1' },
);
assert.equal(reference.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
assert.equal(
  processed.stdout.length,
  reference.length,
  'GPU frames must drain through natural EOF',
);
let error = 0;
for (let index = 0; index < reference.length; index++) {
  error += Math.abs(reference[index] - processed.stdout[index]);
}
assert.ok(
  error / reference.length < MAX_PIXEL_ERROR,
  `GPU mean pixel error: ${error / reference.length}`,
);
const loaded = processed.stderr.toString();
if (shared) {
  assert.match(loaded, /libMoltenVK\.dylib/);
  assert.match(loaded, /libvulkan.*\.dylib/);
} else {
  assert.doesNotMatch(loaded, /lib(?:vulkan|MoltenVK).*\.dylib/);
}
console.log(
  `MoltenVK ${shared ? 'shared' : 'static'}: real Metal-backed GPU scaling, pixels, complete EOF and single runtime route passed`,
);
