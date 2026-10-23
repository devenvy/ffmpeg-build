import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Hash only call_kernel: FFmpeg 8.1.3 and 9.0.2 have the same affected function.
const AFFECTED = 'd232b0034a3be1d46da8acefa8f1e349152227550d7983aaca57dbb58171dd37';
const FIXED = 'df64e127733c8c89c89563624fbbdd7a6a0b0f29c522129cb2af3e7024754e65';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Backport FFmpeg 7f2e5cdd7c3a: borrowed Metal objects belong to their autorelease pool. */
export function fixMetalAutorelease(dir: string, configure: readonly string[]): boolean {
  if (!configure.includes('--enable-metal')) {
    return false;
  }
  const path = join(dir, 'libavfilter', 'vf_yadif_videotoolbox.m');
  const before = readFileSync(path, 'utf8');
  const kernel = before.match(/static void call_kernel\([\s\S]*?\n}\n/)?.[0];
  if (kernel && hash(kernel) === FIXED) {
    return false;
  }
  if (!kernel || hash(kernel) !== AFFECTED) {
    throw new Error(
      'Metal call_kernel is unrecognized; review the upstream autorelease fix for this FFmpeg source',
    );
  }
  const declaration = '    YADIFVTContext *s = ctx->priv;\n';
  const start = kernel.indexOf(declaration) + declaration.length;
  const releases = '\n    ff_objc_release(&encoder);\n    ff_objc_release(&buffer);\n}\n';
  const commands = kernel.slice(start, -releases.length).trimEnd().split('\n');
  const fixed = `${kernel.slice(0, start)}    @autoreleasepool {\n${commands
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n')}\n    }\n}\n`;
  if (hash(fixed) !== FIXED) {
    throw new Error('Metal backport differs from the reviewed upstream fix');
  }
  writeFileSync(path, before.replace(kernel, fixed));
  return true;
}
