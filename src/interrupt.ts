// SIGINT and SIGTERM while a command runs children (a build in Docker or natively): the signal is forwarded to the
// running child, which gets a deadline to end before it is killed; only once it is gone does the command unwind, so
// its `finally` blocks (staging folders, locks) run after the child stopped writing. The handlers are installed for
// the command's scope only.

/** 128 + the signal's number: what a shell reports for a process a signal ended. */
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

const exitCodeOf = (signal: 'SIGINT' | 'SIGTERM'): number =>
  signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM;

/** The command was stopped by a signal; the CLI exits 128 + its number (130 for SIGINT, 143 for SIGTERM). */
export class Interrupted extends Error {
  readonly signal: 'SIGINT' | 'SIGTERM';
  readonly exitCode: number;
  constructor(signal: 'SIGINT' | 'SIGTERM') {
    super(`stopped (${signal}); nothing was replaced`);
    this.signal = signal;
    this.exitCode = exitCodeOf(signal);
  }
}

type Listener = (signal: 'SIGINT' | 'SIGTERM', repeated: boolean) => void;

let scopes = 0;
let received: 'SIGINT' | 'SIGTERM' | undefined;
let count = 0;
const listeners = new Set<Listener>();

const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
  received ??= signal;
  count++;
  for (const l of [...listeners]) {
    l(signal, count > 1);
  }
};
const onInt = () => onSignal('SIGINT');
const onTerm = () => onSignal('SIGTERM');

/**
 * Runs `fn` with SIGINT/SIGTERM handled: a signal is passed to whatever subscribed (running children) instead of
 * ending this process at once. When `fn` ends after a signal, Interrupted is thrown in place of its result.
 */
export async function withInterrupts<T>(fn: () => Promise<T>): Promise<T> {
  if (scopes++ === 0) {
    received = undefined;
    count = 0;
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
  }
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    if (received && !(e instanceof Interrupted)) {
      throw new Interrupted(received);
    }
    throw e;
  } finally {
    if (--scopes === 0) {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    }
  }
  if (received) {
    throw new Interrupted(received);
  }
  return result;
}

/** Calls `listener` for each signal while subscribed (`repeated`: not the first); returns the unsubscribe function. */
export function onInterrupt(listener: Listener): () => void {
  listeners.add(listener);
  if (received) {
    listener(received, false);
  } // arrived before the child started
  return () => {
    listeners.delete(listener);
  };
}
