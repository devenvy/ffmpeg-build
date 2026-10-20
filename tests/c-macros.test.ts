import { describe, expect, it } from 'vitest';

import { Sources, tokenize } from '../src/c-macros.ts';

/** The top-level statements of `main.c` (with these other files), as text. */
function statements(main: string, others: Record<string, string> = {}): string[] {
  const files = new Map(Object.entries({ 'lib/main.c': main, ...others }));
  return new Sources(files)
    .topLevel('lib/main.c')
    .map((toks) => toks.map((t, i) => (i && t.space ? ' ' : '') + t.t).join(''));
}

describe('tokenize', () => {
  it('splits C into tokens, strings and punctuators whole', () => {
    expect(tokenize('a ## b, "x \\" y" ...->1.5e-3').map((t) => t.t)).toEqual([
      'a',
      '##',
      'b',
      ',',
      '"x \\" y"',
      '...',
      '->',
      '1.5e-3',
    ]);
  });
});

describe('Sources.topLevel', () => {
  it('expands a macro that writes a definition, with # and ##', () => {
    const main = [
      // name_, as FFmpeg writes it: a parameter called name would replace .p.name's too
      '#define CODEC(name_, str) const FFCodec ff_ ## name_ ## _decoder = { .p.name = #str, };',
      'CODEC(foo_bar, foo-bar)',
    ].join('\n');
    expect(statements(main)).toEqual([
      'const FFCodec ff_foo_bar_decoder = { .p.name = "foo-bar", };',
    ]);
  });

  it('expands arguments before substituting them, and rescans the result', () => {
    const main = [
      '#define PCM_1(name) ff_ ## name ## _encoder = #name;',
      '#define PCM_0(name)',
      '#define PCM_2(cf, name) PCM_ ## cf(name)',
      '#define PCM_3(cf, name) PCM_2(cf, name)',
      '#define PCM(id, name) PCM_3(CONFIG_PCM_ ## id ## _ENCODER, pcm_ ## name)',
      'PCM(S16LE, s16le)',
    ].join('\n');
    // CONFIG_<NAME> reads as 1: the macro picks the variant that defines it
    expect(statements(main)).toEqual(['ff_pcm_s16le_encoder = "pcm_s16le";']);
  });

  it('passes a variadic macro the rest of its arguments, and never expands a macro inside itself', () => {
    const main = [
      '#define LIST(first, ...) first: __VA_ARGS__',
      '#define SELF SELF + 1',
      'x = LIST(a, b, c) SELF;',
    ].join('\n');
    expect(statements(main)).toEqual(['x = a: b, c SELF + 1;']);
  });

  it('stringifies an argument as written and joins pasted names', () => {
    const main = [
      '#define STR(x) #x',
      '#define XSTR(x) STR(x)',
      '#define NAME h264',
      'a = STR(NAME) XSTR(NAME) STR("q");',
    ].join('\n');
    expect(statements(main)).toEqual(['a = "NAME" "h264" "\\"q\\"";']);
  });

  it('skips function bodies, struct bodies and comments, and keeps initializers whole', () => {
    const main = [
      '/* a comment { */',
      'static int f(void) { int x = { 1 }; return NAME; } // }',
      'struct s { int a; };',
      'const T t = { .a = { 1, 2 }, .b = "}" };',
    ].join('\n');
    expect(statements(main)).toEqual([
      'static int f(void)',
      'struct s',
      ';',
      'const T t = { .a = { 1, 2 }, .b = "}" };',
    ]);
  });

  it('takes only the first branch of each #if (the one after an #if 0 otherwise)', () => {
    const main = [
      '#if HAVE_A',
      'static void f(void) {',
      '#else',
      'static void g(void) {',
      '#endif',
      '}',
      '#if 0',
      '#define N "dead"',
      '#elif X',
      '#define N "live"',
      '#else',
      '#define N "other"',
      '#endif',
      'const T t = { .name = N };',
    ].join('\n');
    expect(statements(main)).toEqual(['static void f(void)', 'const T t = { .name = "live" };']);
  });

  it('follows #include "..." beside the file and from the root, each file once', () => {
    const main = [
      '#include "codec.h"',
      '#include "lib/codec.h"',
      '#include "libavutil/macros.h"',
      '#include <stdio.h>',
      '#include "template.c"',
      'DEF(b)',
    ].join('\n');
    const others = {
      'lib/codec.h': '#define DEF(n) const FFCodec ff_ ## n = { .name = AV_STRINGIFY(n) };',
      'libavutil/macros.h': '#define AV_STRINGIFY(s) AV_TOSTRING(s)\n#define AV_TOSTRING(s) #s',
      'lib/template.c': 'DEF(a)\n#undef DEF\n#define DEF(n) n;',
    };
    expect(statements(main, others)).toEqual(['const FFCodec ff_a = { .name = "a" };', 'b;']);
  });

  it('leaves a function-like name without a call, and a call that never closes, as they are', () => {
    expect(statements('#define F(x) x\nint (*p)(int) = F;\nG F(a')).toEqual([
      'int (*p)(int) = F;',
      'G F(a',
    ]);
  });
});
