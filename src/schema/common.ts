import { z } from 'zod';

export const text = z.string({ error: 'expected text' }).min(1, { error: 'must not be empty' });
export const name = z.string({ error: 'expected a name' }).regex(/^[a-z0-9][a-z0-9._+-]*$/, {
  error: 'expected a lowercase name like x265 or whisper.cpp',
});
export const linkage = z.enum(['static', 'shared', 'system-shared']);
export type Linkage = z.output<typeof linkage>;
export const libraryLinks = z.record(name, linkage);
export const version = z
  .string({ error: 'expected a version' })
  .regex(/^\d+(\.\d+)*$/, { error: 'expected a version like 9.0.2' });
/** The Android API levels the image's NDK (r27d) builds for: 64-bit Android starts at 21. */
const ANDROID_API_LEVELS = { min: 21, max: 35 } as const;
const ANDROID_API_ERROR = `expected an Android API level from ${ANDROID_API_LEVELS.min} to ${ANDROID_API_LEVELS.max}, like 24`;
/** An Android API level (`android-api: 24`): YAML gives it as text, it is a number after parsing. */
export const androidApiLevel = z
  .string({ error: ANDROID_API_ERROR })
  .regex(/^\d+$/, { error: ANDROID_API_ERROR })
  .transform(Number)
  .refine((n) => n >= ANDROID_API_LEVELS.min && n <= ANDROID_API_LEVELS.max, {
    error: ANDROID_API_ERROR,
  });
export const flag = z
  .enum(['true', 'false'], { error: 'expected true or false' })
  .transform((v) => v === 'true');

/** One value or a list of them; always a list after parsing. */
export function oneOrMany<T extends z.ZodType>(
  item: T,
  error: string,
): z.ZodPipe<
  z.ZodUnion<readonly [T, z.ZodArray<T>]>,
  z.ZodTransform<z.output<T>[], z.output<z.ZodUnion<readonly [T, z.ZodArray<T>]>>>
> {
  return z
    .union([item, z.array(item).min(1)], { error })
    .transform((v) => (Array.isArray(v) ? v : [v]) as z.output<T>[]);
}

const KIND: Record<string, string> = {
  array: 'a list',
  object: 'keys and values',
  string: 'text',
  record: 'keys and values',
};

/**
 * zod issues as plain "path: message" lines, e.g. "with[0].whisper.ffmpeg: expected ...". zod's own
 * wording ("Unrecognized key", "Invalid input: expected array, received object") never reaches users.
 * `keyHints` adds the allowed keys to an unknown-key message, by path ('' is the top level).
 */
export function formatIssues(error: z.ZodError, keyHints: Record<string, string> = {}): string[] {
  return error.issues.flatMap((issue) => {
    const where = issue.path
      .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
      .join('')
      .replace(/^\./, '');
    const at = (message: string) => (where ? `${where}: ${message}` : message);
    if (issue.code === 'unrecognized_keys') {
      const hint = keyHints[where];
      return issue.keys.map((key) => at(`unknown key "${key}"${hint ? ` (${hint})` : ''}`));
    }
    if (issue.code === 'invalid_type' && issue.message.startsWith('Invalid input')) {
      return [at(`expected ${KIND[issue.expected] ?? issue.expected}`)];
    }
    return [at(issue.message)];
  });
}
