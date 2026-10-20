// Enough of C's preprocessor to read the definitions in FFmpeg's sources that macros write: `#define`, `#undef` and
// `#include "..."` (followed through the files given), function-like and object-like macros with `#`, `##` and
// `__VA_ARGS__`, expanded the way the standard says (arguments first, then the result rescanned, a macro never
// expanding inside itself). Conditionals aren't evaluated: each `#if`'s first branch is taken, and `CONFIG_<NAME>`
// reads as 1, as in a build with everything on. Only what is outside functions is expanded: the declarations, and the
// macro calls that write them.
import { posix } from 'node:path';

/** A token: its text, whether space came before it, and the macros it may no longer expand (it came out of them). */
export interface Tok {
  t: string;
  space: boolean;
  hide?: ReadonlySet<string>;
  /** a `#` or `##` of a macro's own body (an argument's `##` is just text) */
  op?: boolean;
}

interface Macro {
  params?: string[]; // undefined: object-like
  variadic?: boolean;
  body: Tok[];
}

type Directive = { kind: 'define'; name: string; macro: Macro } | { kind: 'undef'; name: string };
type Op = Directive | { kind: 'include'; file: string } | { kind: 'code'; toks: Tok[] };

const TOKEN =
  /(\s*)([A-Za-z_]\w*|\.?\d(?:[eEpP][+-]|[\w.])*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|##|\.\.\.|->|\S)/gy;

/** The tokens of a line of C (comments already gone). */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    out.push({ t: m[2]!, space: m[1]!.length > 0 });
  }
  return out;
}

/** The text without its comments and line continuations; a comment becomes a space, strings stay as they are. */
function stripComments(text: string): string {
  return text
    .replace(/\\\r?\n/g, '')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (s) =>
      s.startsWith('/') ? ' ' : s,
    );
}

const DEFINE = /^#\s*define\s+([A-Za-z_]\w*)(\(([^)]*)\))?(.*)$/;
const VARIADIC = '...';

function parseDefine(line: string): Op | undefined {
  const m = DEFINE.exec(line);
  if (!m) {
    return undefined;
  }
  const body = tokenize(m[4]!).map((t, i) => ({
    ...t,
    ...(i === 0 ? { space: false } : {}),
    ...(t.t === '#' || t.t === '##' ? { op: true } : {}),
  }));
  const name = m[1]!;
  if (m[2] === undefined) {
    return { kind: 'define', name, macro: { body } };
  }
  const params = m[3]!
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const last = params.at(-1);
  if (!last?.endsWith(VARIADIC)) {
    return { kind: 'define', name, macro: { params, body } };
  }
  // `...` is __VA_ARGS__; GNU's `args...` names it
  params[params.length - 1] =
    last === VARIADIC ? '__VA_ARGS__' : last.slice(0, -VARIADIC.length).trim();
  return { kind: 'define', name, macro: { params, variadic: true, body } };
}

/** A directive or a line of code: what it adds to the file's list, if anything. */
function parseLine(line: string): Op | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) {
    const toks = tokenize(line);
    return toks.length
      ? { kind: 'code', toks: [{ ...toks[0]!, space: true }, ...toks.slice(1)] }
      : undefined;
  }
  const undef = /^#\s*undef\s+([A-Za-z_]\w*)/.exec(trimmed);
  const inc = /^#\s*include\s+"([^"]+)"/.exec(trimmed);
  if (undef) {
    return { kind: 'undef', name: undef[1]! };
  }
  return inc ? { kind: 'include', file: inc[1]! } : parseDefine(trimmed);
}

/**
 * A file's directives and code, in order. Of each `#if`, only its first branch counts (as in a build with everything
 * on: the code stays one whole configuration's, its braces balanced), or the first after an `#if 0`.
 */
function parseFile(text: string): Op[] {
  const ops: Op[] = [];
  // per open #if: whether its current branch counts, and whether one of its branches already did
  const conds: { on: boolean; done: boolean }[] = [];
  for (const line of stripComments(text).split('\n')) {
    const cond = /^#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line.trim());
    const op = cond ? undefined : parseLine(line);
    if (cond) {
      const [, word, rest] = cond;
      const zero = /^\s*0\s*$/.test(rest!);
      const top = conds.at(-1);
      if (word === 'endif') {
        conds.pop();
      } else if (word!.startsWith('if')) {
        conds.push({ on: !zero, done: !zero });
      } else if (top) {
        top.on = !top.done && !(word === 'elif' && zero);
        top.done ||= top.on;
      }
    } else if (op && conds.every((c) => c.on)) {
      ops.push(op);
    }
  }
  return ops;
}

const withHide = (tok: Tok, hide: ReadonlySet<string>): Tok => ({
  t: tok.t,
  space: tok.space,
  hide: tok.hide ? new Set([...tok.hide, ...hide]) : hide,
});

/** `#arg`: the argument's text as a string literal, a space wherever there was space. */
function stringify(arg: Tok[]): Tok {
  const text = arg
    .map((t, i) => (i > 0 && t.space ? ' ' : '') + t.t)
    .join('')
    .replace(/["\\]/g, (c) => `\\${c}`);
  return { t: `"${text}"`, space: false };
}

/** ##: the tokens on either side become one. */
function paste(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    const left = out.at(-1);
    const right = toks[i + 1];
    if (tok.op && tok.t === '##' && left && right) {
      out[out.length - 1] = { t: left.t + right.t, space: left.space, hide: left.hide };
      i++;
    } else {
      out.push(tok);
    }
  }
  return out;
}

/** A call's arguments, taken off the stack: split at its top-level commas, up to the closing parenthesis. */
function collectArgs(stack: Tok[]): { args: Tok[][]; close: Tok } | undefined {
  const taken: Tok[] = [stack.pop()!];
  const args: Tok[][] = [[]];
  let depth = 0;
  while (stack.length) {
    const tok = stack.pop()!;
    taken.push(tok);
    if (tok.t === ')' && depth === 0) {
      return { args, close: tok };
    }
    if (tok.t === ',' && depth === 0) {
      args.push([]);
    } else {
      depth += tok.t === '(' ? 1 : 0;
      depth -= tok.t === ')' ? 1 : 0;
      args.at(-1)!.push(tok);
    }
  }
  stack.push(...taken.reverse()); // the call doesn't close: put it all back
  return undefined;
}

/** The arguments, one per parameter: a variadic macro's last takes the rest, commas and all. */
function bind(macro: Macro, args: Tok[][]): Tok[][] {
  const n = macro.params!.length;
  if (macro.variadic && args.length > n) {
    const rest = args.slice(n - 1).flatMap((a, i) => (i ? [{ t: ',', space: false }, ...a] : a));
    return [...args.slice(0, n - 1), rest];
  }
  return n === 0 && args.length === 1 && !args[0]!.length ? [] : args;
}

const IDENT = /^[A-Za-z_]\w*$/;
const CONFIG = /^CONFIG_\w+$/;
const ONE: Macro = { body: [{ t: '1', space: false }] };
const isPaste = (t: Tok | undefined): boolean => t?.op === true && t.t === '##';

/** Expands tokens with the macros given (which the caller keeps up to date as definitions come). */
function expander(macros: ReadonlyMap<string, Macro>): (input: readonly Tok[]) => Tok[] {
  const lookup = (name: string): Macro | undefined =>
    macros.get(name) ?? (CONFIG.test(name) ? ONE : undefined);

  /** A macro's body with its arguments in: `#p` a string, `p` beside `##` as written, else expanded; then pasted. */
  const substitute = (macro: Macro, args: Tok[][], hide: ReadonlySet<string>): Tok[] => {
    const params = macro.params ?? [];
    const argOf = (t: Tok | undefined): Tok[] | undefined => {
      const i = t && !t.op ? params.indexOf(t.t) : -1;
      return i < 0 ? undefined : (args[i] ?? []);
    };
    const expanded = new Map<Tok[], Tok[]>();
    const body = macro.body;
    const out: Tok[] = [];
    for (let i = 0; i < body.length; i++) {
      const b = body[i]!;
      const arg = argOf(b);
      const stringified = b.op && b.t === '#' ? argOf(body[i + 1]) : undefined;
      if (stringified) {
        out.push({ ...stringify(stringified), space: b.space });
        i++;
      } else if (!arg) {
        out.push(b);
      } else if (isPaste(body[i - 1]) || isPaste(body[i + 1])) {
        // as written; an empty argument beside ## is a placemarker
        const toks = arg.length ? arg : [{ t: '', space: false }];
        out.push(...toks.map((t, j) => (j === 0 ? { ...t, space: b.space } : t)));
      } else {
        if (!expanded.has(arg)) {
          expanded.set(arg, expand(arg));
        }
        out.push(...expanded.get(arg)!.map((t, j) => (j === 0 ? { ...t, space: b.space } : t)));
      }
    }
    return paste(out)
      .filter((t) => t.t !== '')
      .map((t) => withHide(t, hide));
  };

  /** The result of a macro takes the place of its name: the space before the name comes before it. */
  const spaced = (result: Tok[], at: Tok): Tok[] =>
    result.map((t, i) => (i === 0 ? { ...t, space: at.space } : t));

  /** The tokens, every macro in them expanded. */
  function expand(input: readonly Tok[]): Tok[] {
    const out: Tok[] = [];
    const stack = [...input].reverse(); // the next token is on top: a macro's result goes back on it, to be rescanned
    while (stack.length) {
      const tok = stack.pop()!;
      const macro = IDENT.test(tok.t) && !tok.hide?.has(tok.t) ? lookup(tok.t) : undefined;
      const call = macro?.params && stack.at(-1)?.t === '(' ? collectArgs(stack) : undefined;
      if (macro && !macro.params) {
        const result = substitute(macro, [], new Set([...(tok.hide ?? []), tok.t]));
        stack.push(...spaced(result, tok).reverse());
      } else if (macro && call) {
        const hide = new Set([...(tok.hide ?? [])].filter((h) => call.close.hide?.has(h)));
        hide.add(tok.t);
        stack.push(...spaced(substitute(macro, bind(macro, call.args), hide), tok).reverse());
      } else {
        // not a macro, or a function-like one's name without a call (or one that never closes)
        out.push(tok);
      }
    }
    return out;
  }
  return expand;
}

/** A translation unit, in order: its code's tokens, and the definitions that change the macros on the way. */
type Item = Tok | Directive;
const isTok = (i: Item): i is Tok => 't' in i;

/** Where the brace group starting at `from` ends: its closing brace, or the end. */
function groupEnd(items: readonly Item[], from: number): number {
  let depth = 0;
  for (let i = from; i < items.length; i++) {
    const item = items[i]!;
    depth += isTok(item) && item.t === '{' ? 1 : 0;
    depth -= isTok(item) && item.t === '}' ? 1 : 0;
    if (depth === 0) {
      return i;
    }
  }
  return items.length - 1;
}

/**
 * The parts of a translation unit outside functions, struct bodies and enums, each statement with every macro in it
 * expanded (with the macros defined before it): what a source file declares and defines at the top level.
 */
function topLevel(items: readonly Item[]): Tok[][] {
  const macros = new Map<string, Macro>();
  const expand = expander(macros);
  const out: Tok[][] = [];
  let chunk: Tok[] = [];
  let parens = 0;
  const apply = (op: Directive): void => {
    if (op.kind === 'define') {
      macros.set(op.name, op.macro);
    } else {
      macros.delete(op.name);
    }
  };
  const flush = (): void => {
    if (chunk.length) {
      out.push(expand(chunk));
    }
    chunk = [];
    parens = 0;
  };
  /** The items from..to: the definitions among them applied, and the tokens kept when asked. */
  const take = (from: number, to: number, keep: boolean): void => {
    for (const item of items.slice(from, to + 1)) {
      if (!isTok(item)) {
        apply(item);
      } else if (keep) {
        chunk.push(item);
      }
    }
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!isTok(item)) {
      flush();
      apply(item);
    } else if (item.t === '{' && parens === 0) {
      // an initializer is kept whole; a function's body, a struct's or an enum's is skipped
      const initializer = chunk.at(-1)?.t === '=';
      const end = groupEnd(items, i);
      take(i, end, initializer);
      if (!initializer) {
        flush();
      }
      i = end;
    } else {
      parens = Math.max(0, parens + (item.t === '(' ? 1 : 0) - (item.t === ')' ? 1 : 0));
      chunk.push(item);
      if (item.t === ';' && parens === 0) {
        flush();
      }
    }
  }
  flush();
  return out;
}

/** The C sources of a tree, by path from its root ('/' separated), read the way a preprocessor would. */
export class Sources {
  private readonly parsed = new Map<string, Op[]>();
  private readonly files: ReadonlyMap<string, string>;

  constructor(files: ReadonlyMap<string, string>) {
    this.files = files;
  }

  private ops(path: string): Op[] {
    let ops = this.parsed.get(path);
    if (!ops) {
      ops = parseFile(this.files.get(path) ?? '');
      this.parsed.set(path, ops);
    }
    return ops;
  }

  /** Where `#include "file"` in `from` leads: beside it, else from the root. */
  private resolve(from: string, file: string): string | undefined {
    const beside = posix.normalize(posix.join(posix.dirname(from), file));
    const fromRoot = posix.normalize(file);
    if (this.files.has(beside)) {
      return beside;
    }
    return this.files.has(fromRoot) ? fromRoot : undefined;
  }

  /**
   * One source file's top-level statements, expanded, with what it includes (a template's or a header's definitions
   * are the including file's). An include outside the files given (a system header) is left out.
   */
  topLevel(path: string): Tok[][] {
    const items: Item[] = [];
    const seen = new Set<string>([path]);
    const walk = (file: string): void => {
      for (const op of this.ops(file)) {
        const to = op.kind === 'include' ? this.resolve(file, op.file) : undefined;
        if (op.kind === 'code') {
          items.push(...op.toks);
        } else if (op.kind !== 'include') {
          items.push(op);
        } else if (to && !seen.has(to)) {
          seen.add(to); // as include guards would
          walk(to);
        }
      }
    };
    walk(path);
    return topLevel(items);
  }
}
