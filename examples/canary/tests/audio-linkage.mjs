import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT = 30000;
const SAMPLE_BYTES = 4;
const DURATION_PRECISION = 3;
const MIN_DURATION = 0.7;
const MAX_DURATION = 1.3;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const work = mkdtempSync(join(tmpdir(), 'ffb-audio-linkage-'));
const cases = [
  {
    encoder: 'libvorbis',
    decoder: 'libvorbis',
    extension: 'ogg',
    rate: 44100,
    channels: 2,
    bitrate: '128k',
  },
  {
    encoder: 'libopus',
    decoder: 'libopus',
    extension: 'ogg',
    rate: 48000,
    channels: 1,
    bitrate: '64k',
  },
  {
    encoder: 'libspeex',
    decoder: 'libspeex',
    extension: 'ogg',
    rate: 16000,
    channels: 1,
    bitrate: '24k',
  },
  {
    encoder: 'libmp3lame',
    decoder: 'mp3float',
    extension: 'mp3',
    rate: 44100,
    channels: 2,
    bitrate: '128k',
  },
  {
    encoder: 'libshine',
    decoder: 'mp3float',
    extension: 'mp3',
    rate: 44100,
    channels: 2,
    bitrate: '128k',
  },
];
const command = (args) => {
  const result = spawnSync(process.env.FFMPEG, ['-hide_banner', '-nostdin', ...args], {
    timeout: TIMEOUT,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
try {
  for (const { encoder, decoder, extension, rate, channels, bitrate } of cases) {
    const path = join(work, `${encoder}.${extension}`);
    command([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=997:sample_rate=48000:duration=1',
      '-ar',
      String(rate),
      '-ac',
      String(channels),
      '-c:a',
      encoder,
      '-b:a',
      bitrate,
      path,
    ]);
    const pcm = command([
      '-c:a',
      decoder,
      '-i',
      path,
      '-ar',
      String(rate),
      '-ac',
      String(channels),
      '-f',
      'f32le',
      '-',
    ]);
    const samples = pcm.length / SAMPLE_BYTES;
    const duration = samples / (rate * channels);
    assert.ok(
      duration >= MIN_DURATION && duration <= MAX_DURATION,
      `${encoder}: unexpected decoded duration ${duration}`,
    );
    let power = 0;
    for (let offset = 0; offset < pcm.length; offset += SAMPLE_BYTES) {
      const sample = pcm.readFloatLE(offset);
      assert.ok(Number.isFinite(sample), `${encoder}: invalid decoded sample`);
      power += sample * sample;
    }
    power /= samples;
    assert.ok(
      power >= MIN_POWER && power <= MAX_POWER,
      `${encoder}: missing or corrupt audio (${power})`,
    );
    console.log(
      `${encoder}/${decoder}: encoded and decoded ${duration.toFixed(DURATION_PRECISION)} seconds of non-silent audio`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
