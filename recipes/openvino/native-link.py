"""Keep private native archives hidden without splitting the public C++ ABI."""
from pathlib import Path
import shlex

PRIVATE = {
    'libopenvino_reference.a', 'libopenvino_shape_inference.a', 'libpugixml.a',
    'libopenvino_shutdown.a', 'libopenvino_itt.a', 'libopenvino_util.a',
    'libopenvino_xml_util.a', 'libopenvino_common_translators.a',
    'libopenvino_onednn_cpu.a', 'libopenvino_snippets.a',
}
ORIGINAL = 'set(exclude_libs "-Wl,--exclude-libs,ALL")'
REPLACEMENT = 'set(exclude_libs "-Wl,--exclude-libs,' + ':'.join(sorted(PRIVATE)) + '")'


def prepare(source: Path):
    path = source / 'cmake/developer_package/compile_flags/os_flags.cmake'
    text = path.read_text()
    if (text.count(ORIGINAL), text.count(REPLACEMENT)) not in {(1, 0), (0, 1)}:
        raise SystemExit('Review native OpenVINO archive exclusion before changing it')
    path.write_text(text.replace(ORIGINAL, REPLACEMENT, 1))


def audit(ninja: Path, version: str):
    targets = {'libopenvino.so.' + version, 'libopenvino_c.so.' + version,
               'libopenvino_ir_frontend.so.' + version, 'libopenvino_intel_cpu_plugin.so'}
    lines = ninja.read_text().splitlines()
    seen, union = set(), set()
    for index, line in enumerate(lines):
        if not line.startswith('build ') or ': CXX_' not in line:
            continue
        name = Path(line[6:].split(': CXX_', 1)[0]).name
        if name not in targets:
            continue
        if name in seen:
            raise SystemExit('Duplicate native OpenVINO link: ' + name)
        seen.add(name)
        variables = {}
        for later in lines[index + 1:]:
            if not later.startswith('  '):
                break
            key, separator, value = later.strip().partition(' = ')
            if separator:
                variables[key] = value
        archives = {Path(token).name for token in shlex.split(variables['LINK_LIBRARIES'])
                    if token.endswith('.a')}
        if archives - PRIVATE:
            raise SystemExit('Review newly linked OpenVINO private archives: ' + repr(sorted(archives - PRIVATE)))
        union.update(archives)
        flags = shlex.split(variables['LINK_FLAGS'])
        hidden = set()
        for flag in flags:
            if flag.startswith('-Wl,--exclude-libs,'):
                hidden.update(flag.split(',', 2)[2].split(':'))
            elif flag.startswith('-Wl,--exclude-libs='):
                hidden.update(flag.split('=', 1)[1].split(':'))
        if not archives <= hidden or not hidden <= PRIVATE:
            raise SystemExit('Native OpenVINO private archive/compiler ABI boundary mismatch: ' + name)
        if not {'-static-libstdc++', '-shared-libgcc'} <= set(flags):
            raise SystemExit('Native OpenVINO compiler runtime selection changed: ' + name)
    if seen != targets or union != PRIVATE:
        raise SystemExit('Review native OpenVINO target/private archive closure change')
    print('OpenVINO: all four native links retain the public C++ ABI and ten private archive exclusions', flush=True)
