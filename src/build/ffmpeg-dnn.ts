import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_JOIN_SITES = 2;

/** FFmpeg 9's ONNX backend frees unused request items while probing a filter graph: joining thread zero crashes. */
export function fixDnnThreadLifecycle(dir: string, configure: string[]): boolean {
  if (!configure.includes('--enable-libonnxruntime')) {
    return false;
  }
  const sourcePath = join(dir, 'libavfilter', 'dnn', 'dnn_backend_common.c');
  const headerPath = join(dir, 'libavfilter', 'dnn', 'dnn_backend_common.h');
  if (!existsSync(sourcePath) || !existsSync(headerPath)) {
    return false;
  }
  const source = readFileSync(sourcePath, 'utf8');
  const header = readFileSync(headerPath, 'utf8');
  const joinThread = '    pthread_join(async_module->thread_id, &status);\n';
  const created =
    '        return ret;\n    }\n#else\n    ret = async_module->start_inference(async_module->args);';
  if (
    header.includes('int thread_started;') ||
    source.split(joinThread).length - 1 !== EXPECTED_JOIN_SITES ||
    !source.includes(created) ||
    !header.includes('    pthread_t thread_id;\n')
  ) {
    return false;
  }
  writeFileSync(
    headerPath,
    header.replace(
      '    pthread_t thread_id;\n',
      '    pthread_t thread_id;\n    int thread_started;\n',
    ),
  );
  writeFileSync(
    sourcePath,
    source
      .replaceAll(
        joinThread,
        '    if (async_module->thread_started) {\n' +
          '        pthread_join(async_module->thread_id, &status);\n' +
          '        async_module->thread_started = 0;\n' +
          '    }\n',
      )
      .replace(
        created,
        '        return ret;\n    }\n    async_module->thread_started = 1;\n#else\n    ret = async_module->start_inference(async_module->args);',
      ),
  );
  return true;
}
