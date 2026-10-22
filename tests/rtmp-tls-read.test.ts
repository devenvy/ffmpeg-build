import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';

it.skipIf(process.platform !== 'linux')(
  'handles TLS internal progress, interrupted reads, socket timeouts, EOF and fatal errors',
  () => {
    const steps = loadEngineData(packageRoot).recipes.get('librtmp')!.build.steps;
    const adapter = steps.find(
      (step) =>
        !Array.isArray(step) &&
        'write-file' in step &&
        step['write-file'].path === 'librtmp/ffb_tls_read.h',
    );
    expect(adapter && !Array.isArray(adapter) && 'write-file' in adapter).toBe(true);
    if (!adapter || Array.isArray(adapter) || !('write-file' in adapter)) {
      throw new Error('Missing TLS adapter');
    }
    const work = mkdtempSync(join(tmpdir(), 'ffb-rtmp-tls-'));
    try {
      writeFileSync(join(work, 'ffb_tls_read.h'), adapter['write-file'].text);
      writeFileSync(
        join(work, 'check.c'),
        `
#include <assert.h>
#include <errno.h>
#include <stddef.h>
#include <sys/types.h>
typedef void *gnutls_session_t;
#define GNUTLS_E_AGAIN -28
#define GNUTLS_E_INTERRUPTED -52
int RTMP_ctrlC;
static int result, transport_error, calls, progressing;
static ssize_t gnutls_record_recv(gnutls_session_t s, void *b, size_t n) {
  (void)s; (void)b; (void)n;
  calls++;
  if (transport_error >= 0) errno = transport_error;
  return progressing && calls > 1 ? 3 : result;
}
#include "ffb_tls_read.h"
static void check(int value, int error, int progress, int cancelled, int expected, int count, int final_errno) {
  result = value; transport_error = error; progressing = progress; RTMP_ctrlC = cancelled; calls = 0;
  errno = EAGAIN;
  assert(ffb_gnutls_read(NULL, NULL, 16) == expected);
  assert(calls == count);
  if (expected < 0) assert(errno == final_errno);
}
int main(void) {
  check(GNUTLS_E_AGAIN, 0, 1, 0, 3, 2, 0);
  check(GNUTLS_E_AGAIN, -1, 1, 0, 3, 2, 0);
  check(GNUTLS_E_AGAIN, 0, 0, 1, -1, 1, EAGAIN);
  check(GNUTLS_E_INTERRUPTED, EINTR, 1, 0, 3, 2, 0);
  check(GNUTLS_E_AGAIN, EAGAIN, 0, 0, -1, 1, EAGAIN);
  check(GNUTLS_E_INTERRUPTED, EINTR, 0, 1, -1, 1, EINTR);
  check(-110, 0, 0, 0, -1, 1, EIO);
  check(0, 0, 0, 0, 0, 1, 0);
  check(5, 0, 0, 0, 5, 1, 0);
}
`,
      );
      execFileSync('cc', ['-Wall', '-Wextra', '-Werror', 'check.c', '-o', 'check'], { cwd: work });
      execFileSync(join(work, 'check'), [], { timeout: 5000 });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
