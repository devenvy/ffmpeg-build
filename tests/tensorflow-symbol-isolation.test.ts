import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { packageRoot } from '../src/paths.ts';

it.skipIf(process.platform !== 'linux')(
  'keeps TensorFlow private Protobuf, oneDNN and Xbyak definitions and COMDAT groups separate from other backends',
  () => {
    const work = mkdtempSync(join(tmpdir(), 'ffb-tensorflow-symbols-'));
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: work, encoding: 'utf8' });
    const mapping = join(work, 'symbols.map');
    try {
      const source = (protobuf: number, dnnl: number, api: string) => `
struct TableStruct_google_2fprotobuf_2fdescriptor_2eproto { static const int offsets[]; };
const int TableStruct_google_2fprotobuf_2fdescriptor_2eproto::offsets[] = { ${protobuf} };
namespace google::protobuf {
struct Message { virtual ~Message() {} };
int private_value() { Message instance; return TableStruct_google_2fprotobuf_2fdescriptor_2eproto::offsets[0]; }
}
namespace dnnl { int private_value() { return ${dnnl}; } }
namespace Xbyak {
struct LabelManager { virtual ~LabelManager() {} int value() { return ${dnnl + 100}; } };
}
extern "C" int dnnl_private_value() { return dnnl::private_value(); }
extern "C" int ${api}() {
  Xbyak::LabelManager labels;
  return google::protobuf::private_value() + dnnl_private_value() + labels.value();
}
`;
      writeFileSync(join(work, 'tensorflow.cpp'), source(7, 3, 'TF_Value'));
      writeFileSync(join(work, 'other.cpp'), source(11, 5, 'other_api'));
      writeFileSync(
        join(work, 'main.cpp'),
        `extern "C" int TF_Value();
extern "C" int other_api();
int main() { return TF_Value() == 113 && other_api() == 121 ? 0 : 1; }
`,
      );
      for (const name of ['tensorflow', 'other']) {
        run('g++', ['-fPIC', '-c', `${name}.cpp`, '-o', `${name}.o`]);
        run('ar', ['rcs', `lib${name}.a`, `${name}.o`]);
      }
      const args = ['main.cpp', 'libtensorflow.a', 'libother.a', '-o', 'consumer'];
      expect(spawnSync('g++', args, { cwd: work }).status).not.toBe(0);
      expect(run('readelf', ['--section-groups', '--wide', 'libtensorflow.a'])).toContain(
        '_ZN6google8protobuf7MessageD5Ev',
      );
      run('python3', [
        join(packageRoot, 'recipes', 'tensorflow', 'isolate-private.py'),
        mapping,
        join(work, 'libtensorflow.a'),
      ]);
      const mapped = readFileSync(mapping, 'utf8');
      expect(mapped).toContain('_ZN6google8protobuf7MessageD5Ev ffb_tf_');
      expect(mapped).toContain('_ZN4dnnl13private_valueEv ffb_tf_');
      expect(mapped).toContain('dnnl_private_value ffb_tf_');
      expect(mapped).toContain('_ZN5Xbyak12LabelManager5valueEv ffb_tf_');
      expect(mapped).toContain('_ZN5Xbyak12LabelManagerD5Ev ffb_tf_');
      expect(mapped).toMatch(
        /\S*TableStruct_google_2fprotobuf_2fdescriptor_2eproto7offsetsE ffb_tf_/,
      );
      expect(mapped).not.toContain('TF_Value');
      const groups = run('readelf', ['--section-groups', '--wide', 'libtensorflow.a']);
      expect(groups).toContain('[ffb_tf__ZN6google8protobuf7MessageD5Ev]');
      expect(groups).not.toContain('[_ZN6google8protobuf7MessageD5Ev]');
      run('g++', args);
      run(join(work, 'consumer'), []);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
