import { z } from 'zod';

import { folderSchema } from './targets.ts';
import { schemaUrl } from '../paths.ts';
import { JSON_INDENT } from '../text.ts';

/** The JSON Schema editors use to autocomplete and check ffmpeg-build.yml, generated from the CLI's own zod schema. */
export function folderJsonSchema(): string {
  const schema = allowNumbers(z.toJSONSchema(folderSchema, { io: 'input' }));
  // $schema, $id and title first: what a reader of the file sees at its top
  const doc = {
    $schema: schema.$schema,
    $id: schemaUrl(),
    title: 'ffmpeg-build.yml',
    description: 'The builds (targets) of an ffmpeg-build folder, and what each gets',
    ...schema,
  };
  return `${JSON.stringify(doc, null, JSON_INDENT)}\n`;
}

/**
 * Editors read YAML with the usual rules, so `ffmpeg: 9` and `nvenc: 13.0` reach the schema as
 * numbers, while the CLI reads every value as text. Free-text fields therefore also accept numbers;
 * fields with a fixed spelling (enums, patterns like `name`) stay text-only.
 */
function allowNumbers<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(allowNumbers) as T;
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = allowNumbers(value);
  }
  if (out['type'] === 'string' && !('enum' in out) && !('pattern' in out)) {
    out['type'] = ['string', 'number'];
  }
  // a yes/no switch: editors read `true` as a boolean
  if (out['type'] === 'string' && JSON.stringify(out['enum']) === '["true","false"]') {
    out['type'] = ['string', 'boolean'];
    out['enum'] = ['true', 'false', true, false];
  }
  return out as T;
}
