import type { Condition } from './schema/profile.ts';

/** How far JSON output (`--json`, written files) is indented. */
export const JSON_INDENT = 2;

export function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** "8", "8 and 9", "4, 8 and 9". */
export function andList(xs: readonly string[]): string {
  if (xs.length <= 1) {
    return xs.join('');
  }
  return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`;
}

/** One value as itself, several as [a, b]. With `quote`, values that aren't plain words get quotes. */
export function fmtList(values: readonly string[], quote = false): string {
  const show = (v: string) => (quote && !/^[\w.*-]+$/.test(v) ? JSON.stringify(v) : v);
  return values.length === 1 ? show(values[0]!) : `[${values.map(show).join(', ')}]`;
}

/** An entry the way a profile writes it: `whisper { ffmpeg: ">=8" }`. */
export function fmtEntry(e: { name: string; cond?: Condition }): string {
  if (!e.cond) {
    return e.name;
  }
  // a key the condition doesn't set can still be there, holding undefined
  const parts = Object.entries<string[] | undefined>(e.cond)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${fmtList(v!, true)}`);
  return `${e.name} { ${parts.join(', ')} }`;
}

/** "9", "9.0", or the major for `latest`. */
export function seriesLabel(v: { series: string; major: string }): string {
  return v.series === 'latest' ? v.major : v.series;
}
