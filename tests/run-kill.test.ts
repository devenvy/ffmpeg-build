import { describe, expect, it } from 'vitest';

import { retry, run, StepError, stopChildren } from '../src/build/run.ts';

// in this order: stopping is for good (the worker is on its way out)
describe("the build worker's commands", () => {
  it('time out: a command past its deadline is killed and named', async () => {
    await expect(
      run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out after 0\.3 s/);
  });

  it('are stopped with the worker: the signal reaches the running command, and nothing new starts', async () => {
    const running = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    const stopped = stopChildren('SIGTERM', 2_000);
    await expect(running).rejects.toThrow(StepError);
    await stopped;
    await expect(run(process.execPath, ['-e', 'process.exit(0)'])).rejects.toThrow(/stopping/);
    let attempts = 0;
    await expect(
      retry(3, async () => {
        attempts++;
        throw new Error('network');
      }),
    ).rejects.toThrow('network');
    expect(attempts).toBe(1); // no retries once stopping
  });
});
