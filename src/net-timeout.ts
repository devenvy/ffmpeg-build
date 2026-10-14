// The network's deadline error, on its own so net.ts keeps one class per file; net.ts re-exports it.

/** A deadline passed: no answer (or no data) in time. */
export class NetTimeoutError extends Error {}
