// How long retry() waits between attempts, and how long a toolchain image build waits for a package mirror.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageBuildRetry } from '../src/build/docker.ts';
import { retry } from '../src/build/run.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env['FFMPEG_BUILD_IMAGE_ATTEMPTS'];
  delete process.env['FFMPEG_BUILD_IMAGE_RETRY_MS'];
});

/** The waits a retry() asks for, without waiting: setTimeout's delays, with no jitter. */
async function waits(
  attempts: number,
  options?: { firstDelayMs?: number },
): Promise<{ waits: number[]; tries: number }> {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const asked = vi.spyOn(globalThis, 'setTimeout');
  let tries = 0;
  const done = retry(
    attempts,
    async () => {
      tries++;
      return Promise.reject(new Error('mirror mid-sync'));
    },
    () => true,
    options,
  ).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await done).toEqual(new Error('mirror mid-sync'));
  return { waits: asked.mock.calls.map((call) => Number(call[1])), tries };
}

describe('retry', () => {
  it('waits 4 s, then twice as long each time, unless told otherwise', async () => {
    expect(await waits(4)).toEqual({ waits: [4_000, 8_000, 16_000], tries: 4 });
  });

  it('starts from the first wait it is given', async () => {
    expect(await waits(4, { firstDelayMs: 30_000 })).toEqual({
      waits: [30_000, 60_000, 120_000],
      tries: 4,
    });
  });

  it('waits up to a quarter less, at random', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const asked = vi.spyOn(globalThis, 'setTimeout');
    const done = retry(
      2,
      async () => Promise.reject(new Error('x')),
      () => true,
      {
        firstDelayMs: 30_000,
      },
    ).catch(() => undefined);
    await vi.runAllTimersAsync();
    await done;
    expect(asked.mock.calls.map((call) => call[1])).toEqual([22_500]);
  });
});

describe('a toolchain image build', () => {
  it('outlasts a package mirror sync: 4 tries, 30 s, 60 s and 120 s apart', () => {
    expect(imageBuildRetry()).toEqual({ attempts: 4, firstDelayMs: 30_000 });
  });

  it('takes its attempts and first wait from the environment, ignoring what is not a positive number', () => {
    process.env['FFMPEG_BUILD_IMAGE_ATTEMPTS'] = '2';
    process.env['FFMPEG_BUILD_IMAGE_RETRY_MS'] = '1';
    expect(imageBuildRetry()).toEqual({ attempts: 2, firstDelayMs: 1 });
    process.env['FFMPEG_BUILD_IMAGE_ATTEMPTS'] = '0';
    process.env['FFMPEG_BUILD_IMAGE_RETRY_MS'] = 'soon';
    expect(imageBuildRetry()).toEqual({ attempts: 4, firstDelayMs: 30_000 });
  });
});
