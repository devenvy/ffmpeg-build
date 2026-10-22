import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 30000;
const WIDTH = 16;
const HEIGHT = 16;
const FRAMES = 3;
const CHANNELS = 3;
const BLUE_OFFSET = 2;
const RED_MIN = 240;
const OTHER_MAX = 10;
const work = mkdtempSync(join(tmpdir(), 'ffb-rockchip-'));
const execute = (program, args) =>
  spawnSync(program, args, {
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    env: { ...process.env, LD_BIND_NOW: '1' },
  });
try {
  const fixture = Buffer.from(
    readFileSync(new URL('rockchip-red.h264.base64', import.meta.url), 'utf8').trim(),
    'base64',
  );
  assert.equal(
    createHash('sha256').update(fixture).digest('hex'),
    '845bcdec78b47f7df7fdd10a9035ac53d7f3b1bfc3335299e0c411a9184633e1',
  );
  const path = join(work, 'red.h264');
  writeFileSync(path, fixture);
  const flags = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  const decoded = execute(ffmpeg, [
    ...flags,
    '-i',
    path,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stdout.length, WIDTH * HEIGHT * FRAMES * CHANNELS);
  for (let index = 0; index < decoded.stdout.length; index += CHANNELS) {
    assert.ok(decoded.stdout[index] >= RED_MIN);
    assert.ok(
      decoded.stdout[index + 1] <= OTHER_MAX && decoded.stdout[index + BLUE_OFFSET] <= OTHER_MAX,
    );
  }
  const codecs = execute(ffmpeg, ['-hide_banner', '-decoders']);
  assert.equal(codecs.status, 0);
  assert.match(codecs.stdout.toString(), /h264_rkmpp/);
  assert.match(codecs.stdout.toString(), /hevc_rkmpp/);
  const devices = [
    '/dev/mpp_service',
    '/dev/mpp-service',
    '/dev/rkvdec',
    '/dev/vpu_service',
    '/dev/vpu-service',
  ];
  if (!devices.some((device) => existsSync(device))) {
    const unavailable = execute(ffmpeg, [
      ...flags,
      '-c:v',
      'h264_rkmpp',
      '-i',
      path,
      '-f',
      'null',
      '-',
    ]);
    assert.equal(unavailable.signal, null, unavailable.error?.message);
    assert.ok(unavailable.status !== 0 && unavailable.status !== null);
    assert.match(unavailable.stderr.toString(), /mpp|device|initializ|hardware/i);
  }
  for (const name of ['librockchip_mpp', 'librockchip_vpu']) {
    const library = join(dirname(ffmpeg), `${name}.so.1`);
    if (existsSync(library)) {
      const dynamic = execute('readelf', ['-d', library]);
      assert.equal(dynamic.status, 0);
      assert.ok(dynamic.stdout.toString().includes(`[${name}.so.1]`));
      assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
    }
  }
  console.log(
    'Rockchip: three owned software-decoded frames, native codec listing, clean unavailable-device attempt and selected ABI passed; no hardware decode claim',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
