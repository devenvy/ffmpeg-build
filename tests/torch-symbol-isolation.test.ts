import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { packageRoot } from '../src/paths.ts';

it.skipIf(process.platform !== 'linux')(
  'isolates private definitions, references and COMDAT groups while retaining the public Torch API',
  () => {
    const work = mkdtempSync(join(tmpdir(), 'ffb-torch-symbols-'));
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: work, encoding: 'utf8' });
    const mapping = join(work, 'symbols.map');
    try {
      writeFileSync(
        join(work, 'proto.cpp'),
        `namespace google::protobuf {
struct Empty {};
struct Message { virtual ~Message() {} };
int private_value() { Message instance; return 7; }
}
namespace torch {
int api(google::protobuf::Empty*) { return google::protobuf::private_value(); }
}
`,
      );
      writeFileSync(
        join(work, 'other.cpp'),
        `namespace google::protobuf {
struct Message { virtual ~Message() {} };
int private_value() { Message instance; return 11; }
}
int ort_api() { return google::protobuf::private_value(); }
`,
      );
      writeFileSync(
        join(work, 'main.cpp'),
        `namespace google::protobuf { struct Empty {}; }
namespace torch { int api(google::protobuf::Empty*); }
int ort_api();
int main() { return torch::api(nullptr) == 7 && ort_api() == 11 ? 0 : 1; }
`,
      );
      for (const name of ['proto', 'other']) {
        run('g++', ['-fPIC', '-c', `${name}.cpp`, '-o', `${name}.o`]);
        run('ar', ['rcs', `lib${name}.a`, `${name}.o`]);
      }
      const args = ['main.cpp', 'libproto.a', 'libother.a', '-o', 'consumer'];
      expect(spawnSync('g++', args, { cwd: work }).status).not.toBe(0);
      expect(run('readelf', ['--section-groups', '--wide', 'libproto.a'])).toContain(
        '_ZN6google8protobuf7MessageD5Ev',
      );
      run('python3', [
        join(packageRoot, 'recipes', 'torch', 'isolate-protobuf.py'),
        mapping,
        join(work, 'libproto.a'),
      ]);
      const mapped = readFileSync(mapping, 'utf8');
      expect(mapped).toContain('_ZN6google8protobuf7MessageD5Ev ffb_torch_');
      expect(mapped).not.toContain('_ZN5torch');
      const groups = run('readelf', ['--section-groups', '--wide', 'libproto.a']);
      expect(groups).toContain('[ffb_torch__ZN6google8protobuf7MessageD5Ev]');
      expect(groups).not.toContain('[_ZN6google8protobuf7MessageD5Ev]');
      run('g++', args);
      run(join(work, 'consumer'), []);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
