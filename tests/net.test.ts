import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { listenLocal } from './listen.ts';
import { curlArgs, gitNetwork, notWorthRetrying } from '../src/build/fetch.ts';
import { retry, StepError } from '../src/build/run.ts';
import { HttpError, retryDelay, withNetRetry } from '../src/net.ts';

let server: Server | undefined;
afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) {
    await new Promise<void>((r) => {
      running.close(() => {
        r();
      });
    });
  }
});

/** A server answering each request in turn with the given behaviour: a status, or 'hang' (never answers). */
async function serve(script: (number | 'hang')[]): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((_req, res) => {
    const step = script[Math.min(hits++, script.length - 1)]!;
    if (step === 'hang') {
      return;
    }
    res.writeHead(step, { 'content-type': 'text/plain' });
    res.end(`status ${step}`);
  });
  await listenLocal(server);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/x`,
    hits: () => hits,
  };
}

const get = (url: string) => async (signal: AbortSignal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new HttpError(res.status, `HTTP ${res.status}`);
  }
  return res.text();
};

describe('network requests', () => {
  it('retry a server error and a hung request, each attempt with its own deadline', async () => {
    const s = await serve([503, 'hang', 200]);
    expect(await withNetRetry(get(s.url), { attempts: 4, baseMs: 1, timeoutMs: 300 })).toBe(
      'status 200',
    );
    expect(s.hits()).toBe(3);
  });

  it("don't retry a 404: it won't change", async () => {
    const s = await serve([404, 200]);
    await expect(
      withNetRetry(get(s.url), { attempts: 4, baseMs: 1, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(s.hits()).toBe(1);
  });

  it('give up after the attempts allowed, with the last error', async () => {
    const s = await serve([502]);
    await expect(
      withNetRetry(get(s.url), { attempts: 3, baseMs: 1, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ status: 502 });
    expect(s.hits()).toBe(3);
  });

  it("don't retry what isn't a network failure", async () => {
    let calls = 0;
    await expect(
      withNetRetry(
        async () => {
          calls++;
          throw new SyntaxError('bad JSON');
        },
        { attempts: 3, baseMs: 1 },
      ),
    ).rejects.toThrow(SyntaxError);
    expect(calls).toBe(1);
  });

  it('wait longer each time, with jitter, up to a cap', () => {
    const delays = Array.from({ length: 200 }, () => retryDelay(3, 1_000, 30_000));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(4_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(8_000);
    expect(new Set(delays).size).toBeGreaterThan(1);
    expect(retryDelay(20, 1_000, 30_000)).toBeLessThanOrEqual(30_000);
  });
});

describe("the build's downloads", () => {
  it('give curl an overall deadline and a low-speed limit', () => {
    const args = curlArgs('https://example.com/x.tar.gz', '/w/download');
    expect(args.join(' ')).toMatch(
      /--connect-timeout \d+ .*--max-time \d+ .*--speed-limit \d+ --speed-time \d+/,
    );
    expect(args.slice(-3)).toEqual(['https://example.com/x.tar.gz', '-o', '/w/download']);
  });

  it('give git a deadline and a low-speed limit', () => {
    const g = gitNetwork({ PATH: '/bin' });
    expect(g.timeoutMs).toBeGreaterThan(0);
    expect(g.env).toMatchObject({
      PATH: '/bin',
      GIT_HTTP_LOW_SPEED_LIMIT: expect.any(String),
      GIT_HTTP_LOW_SPEED_TIME: expect.any(String),
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it("don't retry a URL that answered 404, but do retry a reset connection", async () => {
    expect(
      notWorthRetrying(
        new StepError('curl exited 22: curl: (22) The requested URL returned error: 404'),
      ),
    ).toBe(true);
    expect(
      notWorthRetrying(
        new StepError('curl exited 22: curl: (22) The requested URL returned error: 503'),
      ),
    ).toBe(false);
    expect(
      notWorthRetrying(
        new StepError('curl exited 56: curl: (56) Recv failure: Connection reset by peer'),
      ),
    ).toBe(false);
    let attempts = 0;
    await expect(
      retry(
        3,
        async () => {
          attempts++;
          throw new StepError('curl exited 22: curl: (22) The requested URL returned error: 404');
        },
        (e) => !notWorthRetrying(e),
      ),
    ).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });
});
