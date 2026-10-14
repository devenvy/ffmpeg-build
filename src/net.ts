// Bounded retries for the network: GitHub's API, release assets and release listings. Each attempt has its own
// deadline; a failure is retried only when it is the network's (no answer, a dropped connection, a timeout, a 5xx,
// 408 or 429), never an answer that won't change (a 404, a 401, bad data). Waits grow exponentially, with jitter.

import { NetTimeoutError } from './net-timeout.ts';

/** An HTTP answer that wasn't a success; `status` says which. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export { NetTimeoutError };

export interface NetRetryOptions {
  /** Attempts in all (default 4, FFMPEG_BUILD_NET_ATTEMPTS). */
  attempts?: number;
  /** The first wait, doubling each time (default 1 s, FFMPEG_BUILD_NET_RETRY_MS). */
  baseMs?: number;
  /** The longest wait (default 30 s). */
  maxMs?: number;
  /** Each attempt's deadline (default 60 s, FFMPEG_BUILD_NET_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Told before each wait (attempt numbers from 1). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MS_PER_S = 1_000;
/** Each wait doubles the one before it. */
const BACKOFF_FACTOR = 2;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

const envNumber = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** The defaults, with the environment's overrides (tests and slow networks). */
export function netDefaults(): Required<Omit<NetRetryOptions, 'onRetry'>> {
  return {
    attempts: envNumber('FFMPEG_BUILD_NET_ATTEMPTS', DEFAULT_ATTEMPTS),
    baseMs: envNumber('FFMPEG_BUILD_NET_RETRY_MS', DEFAULT_BASE_MS),
    maxMs: DEFAULT_MAX_MS,
    timeoutMs: envNumber('FFMPEG_BUILD_NET_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };
}

/** The wait before retry `attempt` (from 1): base·2^attempt capped at `maxMs`, then between half and all of it. */
export function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(maxMs, baseMs * BACKOFF_FACTOR ** attempt);
  const half = cap / BACKOFF_FACTOR;
  return Math.round(half + Math.random() * half);
}

export const retryableStatus = (status: number): boolean =>
  status === HTTP_REQUEST_TIMEOUT ||
  status === HTTP_TOO_MANY_REQUESTS ||
  status >= HTTP_SERVER_ERROR;

/** Whether a failure is the network's: worth another attempt. */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof HttpError) {
    return retryableStatus(e.status);
  }
  if (e instanceof NetTimeoutError) {
    return true;
  }
  const err = e as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  if (!err) {
    return false;
  }
  // fetch() rejects with a TypeError ("fetch failed") whose cause is the socket's error; an abort is our deadline
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return true;
  }
  if (e instanceof TypeError && /fetch failed|terminated|network/i.test(e.message)) {
    return true;
  }
  const code = err.code ?? err.cause?.code;
  return (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/.test(
      code,
    )
  );
}

/**
 * Runs `attempt` until it succeeds, a failure isn't the network's, or the attempts run out (the last error is
 * thrown). Each attempt gets a signal that aborts at its deadline.
 */
export async function withNetRetry<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  options: NetRetryOptions = {},
): Promise<T> {
  const o = { ...netDefaults(), ...options };
  for (let n = 1; ; n++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new NetTimeoutError(`no answer within ${String(o.timeoutMs / MS_PER_S)} s`),
        ),
      o.timeoutMs,
    );
    try {
      return await attempt(controller.signal);
    } catch (e) {
      const error: unknown =
        controller.signal.aborted && !(e instanceof HttpError) ? controller.signal.reason : e;
      if (n >= o.attempts || !isNetworkFailure(error)) {
        throw error;
      }
      const delay = retryDelay(n - 1, o.baseMs, o.maxMs);
      o.onRetry?.(error, n, delay);
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
