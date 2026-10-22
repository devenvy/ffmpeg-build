import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 60000;
const INSTALL_TIMEOUT = 600000;
const MAX_OUTPUT = 8388608;
const PUBLIC_DIRECTORY = 0o755;
const FLOAT_BYTES = 4;
const MIN_SECONDS = 0.7;
const MAX_SECONDS = 1.3;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const AUDIO_RATES = { vorbis: 44100, opus: 48000, speex: 16000 };
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const LIBRARIES = {
  zlib: 'libz.so.1',
  xz: 'liblzma.so.5',
  libogg: 'libogg.so.0',
  libvorbis: 'libvorbis.so.0',
  opus: 'libopus.so.0',
  speex: 'libspeex.so.1',
  libexpat: 'libexpat.so.1',
};
const LZMA_TIFF =
  '49492a00080000000a0000010400010000000100000001010400010000000100000002010300030000008600000003010300010000006d88000006010300010000000200000011010400010000008c00000015010300010000000300000016010400010000000100000017010400010000003c0000001c010300010000000100000000000000080008000800fd377a585a000004e6d6b4460200210116000000742fe5a30100020b162100005ee13c0c321690c100011b030b2fb9101fb6f37d010000000004595a';
const IMAGES = [
  {
    name: 'debian12',
    image:
      'mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0',
    install:
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends binutils zlib1g liblzma5 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3 libopus0 libspeex1 libexpat1',
  },
  {
    name: 'ubuntu24',
    image:
      'mirror.gcr.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac',
    install:
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends nodejs binutils zlib1g liblzma5 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3 libopus0 libspeex1 libexpat1',
  },
  {
    name: 'fedora44',
    image:
      'registry.fedoraproject.org/fedora@sha256:a32cc6149ce88510a5e23ce249d42681d61758d5851c398d29a76e5c94d1ed72',
    install:
      'dnf install -y --setopt=install_weak_deps=False nodejs binutils util-linux zlib-ng-compat xz-libs libogg libvorbis opus speex expat',
  },
];
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.deepEqual(
    { status: result.status, signal: result.signal },
    { status: 0, signal: null },
    `${program} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  return result.stdout;
};
async function client() {
  const ffmpeg = process.env.FFMPEG;
  assert.ok(ffmpeg);
  assert.equal(process.env.LD_BIND_NOW, '1');
  const report = JSON.parse(
    readFileSync(join(dirname(ffmpeg), 'RUNTIME-DEPENDENCIES.json'), 'utf8'),
  );
  const files = readdirSync(dirname(ffmpeg));
  const linked = run('ldd', [ffmpeg]).toString();
  assert.doesNotMatch(linked, /not found/);
  assert.ok(report.libraries.length);
  for (const library of report.libraries) {
    const soname = LIBRARIES[library.name];
    assert.ok(soname, library.name);
    assert.ok(
      !files.some((file) => file === soname || file.startsWith(`${soname}.`)),
      `${soname}: build copy must be omitted`,
    );
    const provider = linked.split('\n').find((line) => line.includes(`${soname} =>`));
    assert.ok(
      provider && !provider.includes('/runtime/'),
      `${soname}: real distro provider ${provider}`,
    );
    assert.ok(Object.keys(library.packages).length);
  }
  const work = mkdtempSync(join(tmpdir(), 'ffb-system-core-'));
  const ff = (args, input) => run(ffmpeg, [...FLAGS, ...args], input);
  try {
    const tiff = join(work, 'authored.tiff');
    writeFileSync(tiff, Buffer.from(LZMA_TIFF, 'hex'));
    assert.deepEqual(
      ff(['-i', tiff, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']),
      Buffer.from('0b1621', 'hex'),
    );
    const original = ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=16x16:rate=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    const png = ff(
      [
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgb24',
        '-video_size',
        '16x16',
        '-i',
        '-',
        '-frames:v',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2pipe',
        '-',
      ],
      original,
    );
    assert.deepEqual(
      ff(
        ['-f', 'image2pipe', '-c:v', 'png', '-i', '-', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        png,
      ),
      original,
    );
    for (const [codec, rate, bitrate] of [
      ['libvorbis', AUDIO_RATES.vorbis, '96k'],
      ['libopus', AUDIO_RATES.opus, '64k'],
      ['libspeex', AUDIO_RATES.speex, '24k'],
    ]) {
      const file = join(work, `${codec}.ogg`);
      ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=997:sample_rate=48000:duration=1',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-c:a',
        codec,
        '-b:a',
        bitrate,
        file,
      ]);
      const pcm = ff([
        '-c:a',
        codec,
        '-i',
        file,
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-f',
        'f32le',
        '-',
      ]);
      assert.equal(pcm.length % FLOAT_BYTES, 0);
      const seconds = pcm.length / FLOAT_BYTES / rate;
      assert.ok(
        seconds >= MIN_SECONDS && seconds <= MAX_SECONDS,
        `${codec}: complete EOF ${seconds}`,
      );
      let energy = 0;
      for (let offset = 0; offset < pcm.length; offset += FLOAT_BYTES) {
        const sample = pcm.readFloatLE(offset);
        assert.ok(Number.isFinite(sample));
        energy += sample * sample;
      }
      const power = energy / (pcm.length / FLOAT_BYTES);
      assert.ok(power > MIN_POWER && power < MAX_POWER, `${codec}: decoded signal ${power}`);
    }
    await import('./font-linkage.mjs');
    console.log(
      'Distribution providers: eager bindings, omitted build copies, zlib/LZMA pixels, external Vorbis/Opus/Speex, Expat font discovery passed',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv.includes('--client')) {
  await client();
} else {
  assert.ok(process.env.FFMPEG);
  const work = mkdtempSync(join(tmpdir(), 'ffb-system-core-run-'));
  try {
    chmodSync(work, PUBLIC_DIRECTORY);
    const runtime = join(work, 'runtime');
    cpSync(dirname(process.env.FFMPEG), runtime, { recursive: true, verbatimSymlinks: true });
    chmodSync(runtime, PUBLIC_DIRECTORY);
    const tests = dirname(fileURLToPath(import.meta.url));
    for (const distribution of IMAGES) {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--mount',
          `type=bind,src=${runtime},dst=/runtime,readonly`,
          '--mount',
          `type=bind,src=${tests},dst=/tests,readonly`,
          '-e',
          'FFMPEG=/runtime/ffmpeg',
          '-e',
          'LD_BIND_NOW=1',
          distribution.image,
          'sh',
          '-ec',
          `${distribution.install} >/dev/null; exec su -s /bin/sh nobody -c 'node /tests/system-core.mjs --client'`,
        ],
        { encoding: 'utf8', timeout: INSTALL_TIMEOUT, maxBuffer: MAX_OUTPUT },
      );
      assert.equal(result.status, 0, `${distribution.name}\n${result.stderr}\n${result.stdout}`);
      console.log(`${distribution.name}: ${result.stdout}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
