// The pieces of a recipe's declared build steps that need no process: placeholders, globs and .pc files.
import { existsSync, readdirSync } from 'node:fs';

import { PC_FIELDS } from '../schema/engine.ts';

export type Value = string | string[];

/** Looks a placeholder's name up: a recipe variable, a built-in like deps or jobs, or the build environment. */
export type Lookup = (name: string) => Value | undefined;

const NAME = /^([A-Za-z_][A-Za-z0-9_-]*)([?|])?/;

/** A placeholder's value as text: a list joined with spaces. */
function valueText(found: Value | undefined): string | undefined {
  return Array.isArray(found) ? found.join(' ') : found;
}

/**
 * Fills in `{name}` placeholders. `{name|fallback}` is the fallback (itself expanded) when the value is unset or empty;
 * `{name?}` is the value or nothing, and marks the result `dropped` when it is empty, so that an argument or environment
 * variable holding it is left out. A list value is joined with spaces. An unknown `{name}` stays as written, as does a
 * brace that starts no placeholder (C code in a written file).
 */
export function expandText(value: string, lookup: Lookup): { text: string; dropped: boolean } {
  let out = '';
  let dropped = false;
  let i = 0;
  while (i < value.length) {
    const open = value.indexOf('{', i);
    if (open < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, open);
    const m = NAME.exec(value.slice(open + 1));
    let end = m ? open + 1 + m[0].length : -1;
    let fallback: string | undefined;
    if (m?.[2] === '|') {
      let depth = 1;
      for (let k = end; k < value.length; k++) {
        if (value[k] === '{') {
          depth++;
        } else if (value[k] === '}' && --depth === 0) {
          fallback = value.slice(end, k);
          end = k;
          break;
        }
      }
      if (fallback === undefined) {
        end = -1;
      }
    }
    if (!m || end < 0 || value[end] !== '}') {
      out += '{';
      i = open + 1;
    } else {
      const text = valueText(lookup(m[1]!));
      if (text) {
        out += text;
      } else if (m[2] === '|') {
        out += expandText(fallback!, lookup).text;
      } else if (m[2] === '?') {
        dropped = true;
      } else {
        out += text ?? value.slice(open, end + 1);
      }
      i = end + 1;
    }
  }
  return { text: out, dropped };
}

/**
 * A command's arguments: an argument that is exactly `{name}` with a list value becomes its items (none for an empty
 * list), and one with an empty `{name?}` is left out.
 */
export function expandArgs(values: readonly string[], lookup: Lookup): string[] {
  const out: string[] = [];
  for (const value of values) {
    const whole = /^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/.exec(value);
    const found = whole ? lookup(whole[1]!) : undefined;
    if (Array.isArray(found)) {
      out.push(...found);
    } else {
      const { text, dropped } = expandText(value, lookup);
      if (!dropped) {
        out.push(text);
      }
    }
  }
  return out;
}

/** One character of a glob segment as a regular expression: `*` and `?` stop at a `/`, the rest is literal. */
function globChar(c: string): string {
  if (c === '*') {
    return '[^/]*';
  }
  if (c === '?') {
    return '[^/]';
  }
  return c.replace(/[\\^$.+()[\]{}|]/g, '\\$&');
}

function segmentPattern(segment: string, ignoreCase: boolean): RegExp {
  const body = Array.from(segment).map(globChar).join('');
  return new RegExp(`^${body}$`, ignoreCase ? 'i' : '');
}

/**
 * The paths a pattern matches, sorted: `*` and `?` within a name (not matching a leading dot, as the shell), `**` for
 * any depth of folders. A pattern without wildcards is itself when it exists.
 */
export function globPaths(pattern: string, ignoreCase = false): string[] {
  const parts = pattern.split(/[\\/]/);
  const first = parts.findIndex((part) => /[*?]/.test(part));
  if (first < 0) {
    return existsSync(pattern) ? [pattern] : [];
  }
  // the folder before the first wildcard as written, then `/` between names, as find(1) prints them
  const base = first === 0 ? '.' : pattern.slice(0, parts.slice(0, first).join('/').length) || '/';
  const join = (dir: string, name: string) =>
    dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`;
  const found = new Set<string>();
  const walk = (dir: string, rest: string[]): void => {
    if (!rest.length) {
      found.add(dir);
      return;
    }
    const [head, ...tail] = rest;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (head === '**') {
      walk(dir, tail);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name), rest);
        }
      }
      return;
    }
    const re = segmentPattern(head!, ignoreCase);
    const matches = entries.filter(
      (entry) => (!entry.name.startsWith('.') || head!.startsWith('.')) && re.test(entry.name),
    );
    for (const entry of matches) {
      if (!tail.length) {
        found.add(join(dir, entry.name));
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name), tail);
      }
    }
  };
  walk(base, parts.slice(first));
  return [...found].sort();
}

/** A whole .pc file, in the layout recipes have always written by hand. */
export function pkgConfigText(
  deps: string,
  pc: {
    name: string;
    description: string;
    version: string;
    requires?: string | undefined;
    libs?: string | undefined;
    libsPrivate?: string | undefined;
    cflags?: string | undefined;
    execPrefix: boolean;
  },
): string {
  return [
    `prefix=${deps}`,
    ...(pc.execPrefix ? [`exec_prefix=\${prefix}`] : []),
    ...(pc.libs !== undefined ? [`libdir=\${prefix}/lib`] : []),
    `includedir=\${prefix}/include`,
    '',
    `Name: ${pc.name}`,
    `Description: ${pc.description}`,
    `Version: ${pc.version}`,
    ...(pc.requires !== undefined ? [`Requires: ${pc.requires}`] : []),
    ...(pc.libs !== undefined ? [`Libs: -L\${libdir} ${pc.libs}`] : []),
    ...(pc.libsPrivate !== undefined ? [`Libs.private: ${pc.libsPrivate}`] : []),
    `Cflags: -I\${includedir}${pc.cflags ? ` ${pc.cflags}` : ''}`,
    '',
  ].join('\n');
}

export interface PcFieldEdit {
  append?: string | undefined;
  prepend?: string | undefined;
  add?: string | undefined;
  set?: string | undefined;
  remove?: string | undefined;
  tokens?: Record<string, string> | undefined;
  removeLibraryPaths?: readonly string[] | undefined;
  missing: 'end' | 'after-libs' | 'skip';
}

const words = (value: string) => value.split(/\s+/).filter(Boolean);
const escaped = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/**
 * One field of a .pc file edited in place, the rest of the file as it was. A field with no line gets one (`Field:
 * <words>`) at the end of the file or after the Libs: line, or is left alone (`missing: skip`); `remove` never adds one.
 */
export function editPcField(
  text: string,
  field: keyof typeof PC_FIELDS,
  edit: PcFieldEdit,
): string {
  const label = PC_FIELDS[field];
  const lines = text.split('\n');
  const isField = (line: string) => line.startsWith(`${label}:`);
  if (!lines.some(isField)) {
    if (
      edit.remove !== undefined ||
      edit.tokens ||
      edit.removeLibraryPaths ||
      edit.missing === 'skip'
    ) {
      return text;
    }
    const line = `${label}: ${edit.set ?? edit.append ?? edit.prepend ?? words(edit.add!).join(' ')}`;
    if (edit.missing === 'end') {
      return `${text}${line}\n`;
    }
    return lines.flatMap((l) => (l.startsWith('Libs:') ? [l, line] : [l])).join('\n');
  }
  // `add` looks at the whole link line: Libs and Libs.private together
  const linkFields =
    field === 'libs' || field === 'libs-private' ? ['Libs:', 'Libs.private:'] : [`${label}:`];
  const present = new Set(
    lines.flatMap((l) => {
      const prefix = linkFields.find((p) => l.startsWith(p));
      return prefix ? words(l.slice(prefix.length)) : [];
    }),
  );
  const toAdd = edit.add !== undefined ? words(edit.add).filter((w) => !present.has(w)) : [];
  return lines
    .map((line) => {
      if (!isField(line)) {
        return line;
      }
      if (edit.append !== undefined) {
        return `${line} ${edit.append}`;
      }
      if (edit.prepend !== undefined) {
        return `${label}: ${edit.prepend}${line.slice(label.length + 1)}`;
      }
      if (edit.set !== undefined) {
        return `${label}: ${edit.set}`;
      }
      if (edit.add !== undefined) {
        return toAdd.length ? `${line} ${toAdd.join(' ')}` : line;
      }
      if (edit.tokens) {
        const tokens = edit.tokens;
        const content = line
          .slice(label.length + 1)
          .replace(/\S+/g, (word) => (Object.hasOwn(tokens, word) ? tokens[word]! : word));
        return `${label}:${content}`;
      }
      if (edit.removeLibraryPaths) {
        const names = edit.removeLibraryPaths;
        return line.replace(/\S+/g, (word) => {
          const path = word.replaceAll('\\', '/');
          const filename = path.slice(path.lastIndexOf('/') + 1);
          const matches =
            path.includes('/') &&
            names.some((name) =>
              new RegExp(`^lib${escaped(name)}\\.(?:a|so(?:\\.[0-9]+)*|dylib|dll\\.a)$`).test(
                filename,
              ),
            );
          return matches ? '' : word;
        });
      }
      let out = line;
      for (const word of words(edit.remove!)) {
        out = out.replace(new RegExp(`[ \\t]+${escaped(word)}(?=[ \\t]|$)`, 'g'), '');
      }
      return out;
    })
    .join('\n');
}

/** Relocate existing installation variables in .pc metadata, preserving all other content. */
export function editPcVariables(
  text: string,
  variables: Record<string, string | undefined>,
): string {
  const pending = new Set(Object.keys(variables).filter((key) => variables[key] !== undefined));
  const output = text
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=');
      const name = line.slice(0, separator).trim();
      const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
      if (separator === -1 || value === undefined) {
        return line;
      }
      pending.delete(name);
      return `${name}=${value}`;
    })
    .join('\n');
  if (pending.size) {
    throw new Error(`pkg-config metadata has no installation variable: ${[...pending].join(', ')}`);
  }
  return output;
}

/** True when `version` is at least `min` (numeric parts, as sort -V). */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}
