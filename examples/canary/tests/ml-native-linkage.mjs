import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const runtime = dirname(ffmpeg);
const backend = process.argv[2];
assert.ok(['openvino', 'torch', 'tensorflow'].includes(backend));
const TIMEOUT = 120000;
const MAX_OUTPUT = 4194304;
const components = {
  torch: ['libtorch.so.2.7', 'libtorch_cpu.so.2.7', 'libc10.so.2.7', 'libtorch_global_deps.so.2.7'],
  openvino: [
    'libopenvino.so.2641',
    'libopenvino_c.so.2641',
    'libopenvino_ir_frontend.so.2641',
    'libopenvino_intel_cpu_plugin.so',
  ],
  tensorflow: ['libtensorflow.so.2'],
}[backend];
function inspect(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: TIMEOUT,
    maxBuffer: MAX_OUTPUT,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const shared = existsSync(join(runtime, components[0]));
const avfilter = readdirSync(runtime).find((name) => /^libavfilter\.so\.\d+$/.test(name));
assert.ok(avfilter);
const dynamic = inspect('readelf', ['-d', join(runtime, avfilter)]);
const entrypoint = {
  openvino: 'libopenvino_c.so.2641',
  torch: 'libtorch_cpu.so.2.7',
  tensorflow: 'libtensorflow.so.2',
}[backend];
assert.equal(dynamic.includes(`Shared library: [${entrypoint}]`), shared);
let standardRuntime = false;
for (const name of components) {
  assert.equal(existsSync(join(runtime, name)), shared, `Incomplete native runtime: ${name}`);
  if (shared) {
    const owner = join(runtime, name);
    const entries = inspect('readelf', ['-d', owner]);
    if (backend === 'tensorflow') {
      assert.doesNotMatch(entries, /NEEDED.*libtensorflow_framework/);
    }
    if (name === 'libopenvino_intel_cpu_plugin.so') {
      assert.doesNotMatch(entries, /SONAME/);
    } else {
      assert.match(entries, new RegExp(`SONAME.*\\[${name.replaceAll('.', '\\.')}\\]`));
    }
    standardRuntime ||= /NEEDED.*libstdc\+\+\.so\.6/.test(entries);
    if (backend === 'tensorflow') {
      const symbols = inspect('nm', ['-D', '--defined-only', owner])
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.trim().split(/\s+/).at(-1).split('@')[0]);
      for (const api of ['TF_Version', 'TF_SessionRun', 'TFE_Execute']) {
        assert.ok(symbols.includes(api), `Missing native public entry point: ${api}`);
      }
      assert.deepEqual(
        // TensorFlow-owned helpers may legitimately take Protobuf parameters.
        symbols.filter((symbol) => /^_Z(?:NK?|T[VIS]N)6google8protobuf/.test(symbol)),
        [],
      );
    }
  }
}
if (shared && backend !== 'tensorflow') {
  assert.ok(standardRuntime, `${backend}: native shared owners must use the system C++ runtime`);
}
if (shared && backend === 'openvino') {
  const plugins = readFileSync(join(runtime, 'plugins.xml'), 'utf8');
  assert.match(plugins, /name="CPU"/);
  assert.doesNotMatch(plugins, /location="(?:\/|[A-Za-z]:)/);
  assert.match(plugins, /location="libopenvino_intel_cpu_plugin.so"/);
}
console.log(
  `${backend} ${shared ? 'shared' : 'static'}: complete native owners, SONAMEs, public entry points and plugin routing passed`,
);
