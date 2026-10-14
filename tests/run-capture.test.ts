import { describe, expect, it } from 'vitest';

import { run, searchOutput } from '../src/build/run.ts';

const node = (script: string) => [process.execPath, ['-e', script]] as const;

describe("a command's captured output", () => {
  it('is capped: a command printing more than the cap fails, naming the cap', async () => {
    const [cmd, args] = node("process.stdout.write('x'.repeat(3 * 1024 * 1024))");
    await expect(run(cmd, args, { capture: true, maxCapture: 1024 * 1024 })).rejects.toThrow(
      /printed more than 1 MB/,
    );
    expect(await run(cmd, args, { capture: true, maxCapture: 4 * 1024 * 1024 })).toHaveLength(
      3 * 1024 * 1024,
    );
  });

  it("keeps only the tail of a failing command's errors", async () => {
    const [cmd, args] = node(
      "process.stderr.write('noise\\n'.repeat(200000) + 'the real error\\n'); process.exitCode = 2",
    );
    const e = await run(cmd, args, { capture: true }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/exited 2: /);
    expect((e as Error).message).toMatch(/the real error$/);
    expect((e as Error).message.length).toBeLessThan(20_000);
  });

  it('can be searched as it streams, without keeping it: needles split across chunks are found', async () => {
    // 8 MB of filler with the needles placed across a 64 KB boundary and at the end
    const [cmd, args] = node(
      "const f = 'a'.repeat(65530); process.stdout.write(f + '/Users/me/' + 'b'.repeat(8 * 1024 * 1024) + '/opt/work/x')",
    );
    expect(
      (await searchOutput(cmd, args, ['/Users/me/', '/opt/work/', '/nowhere/'])).map(
        (f) => f.needle,
      ),
    ).toEqual(['/Users/me/', '/opt/work/']);
  });

  it('says the line each needle was found on, so a failure can name the string', async () => {
    const [cmd, args] = node(
      "process.stdout.write('first\\nfile:///opt/work/deps/etc/xml/catalog\\nlast\\n')",
    );
    expect(await searchOutput(cmd, args, ['/opt/work/'])).toEqual([
      { needle: '/opt/work/', line: 'file:///opt/work/deps/etc/xml/catalog' },
    ]);
  });
});
