"""Rebuild the authored static target after restoring verified source/input records."""
import os
import json
from pathlib import Path
import shutil
import runpy
import subprocess

PATCHES = ['generated.patch', 'build.patch', 'mathextras.patch',
           'toolchains.patch', 'zstd.patch', 'lit_test.patch']

def resources():
    memory = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    for filename in ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']:
        path = Path(filename)
        if path.is_file():
            value = path.read_text().strip()
            if value.isdecimal():
                memory = min(memory, int(value))
    # Eigen-heavy TensorFlow translation units need substantially more memory
    # than the engine's ordinary C library builds. Leave room for the compiler,
    # Bazel server and export link instead of blindly using every logical CPU.
    jobs = min(int(os.environ.get('JOBS', '4')), 8, max(1, memory // (3 * 1024**3)))
    ram_mb = min(18000, max(512, memory * 3 // (4 * 1024**2)))
    return jobs, ram_mb

def run(args, cwd):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)

def prepare_llvm(source):
    llvm = source / 'third_party/ffb_llvm'
    upstream = source / 'third_party/xla/third_party/llvm'
    for name in PATCHES:
        raw = (upstream / name).read_bytes()
        patch = source / '.ffb_inputs' / name
        patch.write_bytes(raw if raw.endswith(b'\n') else raw + b'\n')
        reverse = subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)],
                                 cwd=llvm, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if reverse.returncode:
            run(['git', 'apply', patch], llvm)
    shutil.copy2(upstream / 'llvm.BUILD', llvm / 'BUILD.bazel')
    (llvm / 'WORKSPACE.bazel').write_text('workspace(name = "llvm-raw")\n')
    shutil.copy2(upstream / 'run_lit.sh', llvm / 'mlir/run_lit.sh')

def build(source, shared=False):
    inputs = source / '.ffb_inputs'
    prepare_llvm(source)
    jobs, ram_mb = resources()
    executable = [inputs / 'bazel-7.7.0', '--output_user_root=' + str(source.parent / '_tensorflow-bazel')]
    compiler = runpy.run_path(str(Path(__file__).with_name('native-toolchain.py')))
    output_base = Path(subprocess.check_output(list(map(str, executable + ['info', 'output_base'])),
                                              cwd=source, text=True).strip())
    # A reused Bazel root must restore the native helper before a static build;
    # the shared-only archive selection must never leak into another mode.
    compiler['select'](output_base, shared)
    target = '//tensorflow:libtensorflow.so.2.21.0' if shared else '//ffb:c_api_static'
    options = ['--config=monolithic', '--config=nogcp',
               '--config=nonccl', '--define=with_xla_support=false',
               '--repo_env=USE_PYWRAP_RULES=', '--repo_env=HERMETIC_PYTHON_VERSION=3.12',
               '--define=dynamic_loaded_kernels=false', '--copt=-UAUTOLOAD_DYNAMIC_KERNELS',
               '--override_repository=llvm-raw=' + str(source / 'third_party/ffb_llvm'),
               '--override_repository=go_sdk=' + str(inputs / 'go-sdk'),
               '--enable_bzlmod=false', '--copt=-fPIC', '--copt=-O2',
               '--repository_cache=' + str(inputs / 'repository-cache'),
               '--repository_disable_download',
               '--experimental_repository_resolved_file=' + str(inputs / 'resolved-current.bzl'),
               '--jobs=' + str(jobs), '--local_ram_resources=' + str(ram_mb)]
    if shared:
        options += ['--linkopt=-static-libstdc++', '--linkopt=-shared-libgcc', '--linkopt=-pthread']
    targets = [target, '//tensorflow/ffb:c_api_shared_inventory'] if shared else [target]
    def shared_query():
        query = executable + ['aquery', 'mnemonic("CppLink", ' + target + ')', *options, '--output=jsonproto']
        result = subprocess.check_output(list(map(str, query)), cwd=source, text=True)
        json.loads(result)
        (inputs / 'native-shared-link.json').write_text(result)

    if shared:
        # Analyze the real native link and write CcInfo metadata without
        # compiling its artifacts. Inventory/schema errors must fail before
        # the expensive source build, while all offline pins stay enforced.
        shared_query()
        # A fresh repository first materializes during analysis. That first
        # query is provisional: reanalyze after the strict source adaptation.
        if not compiler['select'](output_base, True):
            raise SystemExit('Native compiler-runtime repository was not materialized')
        shared_query()
        compiler['verify'](json.loads((inputs / 'native-shared-link.json').read_text()))
        run(executable + ['build', '//tensorflow/ffb:c_api_shared_inventory', *options,
                         '--aspects=//ffb:link.bzl%link_inventory', '--output_groups=ffb_inventory'], source)
        run(['python3', Path(__file__).with_name('native-link.py'), source], source)
    command = executable + ['build', *targets, *options,
                            '--aspects=//ffb:link.bzl%link_inventory', '--output_groups=+ffb_link']
    run(command, source)
    if shared:
        shared_query()
        compiler['verify'](json.loads((inputs / 'native-shared-link.json').read_text()))

if __name__ == '__main__':
    source = Path(__file__).resolve().parent.parent
    mode = source / '.ffb_inputs/build-mode.txt'
    build(source, mode.exists() and mode.read_text().strip() == 'shared')
