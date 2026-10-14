import { describe, expect, it } from 'vitest';

import { runStreaming } from '../src/build/docker.ts';
import { Interrupted, withInterrupts } from '../src/interrupt.ts';

const forever = ['-e', 'setInterval(() => {}, 1000)'];
// a child that ignores SIGTERM and SIGINT: only a forced kill ends it (POSIX: Windows can't ignore a kill)
const stubborn = [
  '-e',
  "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
];

describe('a build stopped by SIGINT or SIGTERM', () => {
  it('forwards the signal to the running child, waits for it to end, then reports the interruption', async () => {
    const seen: string[] = [];
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    await expect(
      withInterrupts(async () => {
        const run = runStreaming(process.execPath, forever, undefined, undefined, {
          onInterrupt: (s) => {
            seen.push(`interrupt ${s}`);
          },
        });
        setTimeout(() => {
          process.emit('SIGTERM');
        }, 200);
        const r = await run;
        seen.push(`child gone ${String(r.signal)}`);
        return r;
      }),
    ).rejects.toThrow(Interrupted);
    expect(seen).toEqual(['interrupt SIGTERM', 'child gone SIGTERM']);
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before); // the handlers were scoped
  });

  it.skipIf(process.platform === 'win32')(
    'kills a child that ignores the signal once the deadline passes',
    async () => {
      const started = Date.now();
      await expect(
        withInterrupts(async () => {
          const run = runStreaming(process.execPath, stubborn, undefined, undefined, {
            graceMs: 300,
          });
          setTimeout(() => {
            process.emit('SIGINT');
          }, 300);
          return run;
        }),
      ).rejects.toMatchObject({ signal: 'SIGINT' });
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it('runs as usual when nothing interrupts it', async () => {
    const before = process.listenerCount('SIGTERM');
    const r = await withInterrupts(async () =>
      runStreaming(process.execPath, ['-e', 'process.exit(0)']),
    );
    expect(r.code).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
