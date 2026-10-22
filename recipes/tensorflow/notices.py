"""Preserve actual linked-runtime notices and separately describe build-tool inputs."""
import io
import json
from pathlib import Path
import re
import tarfile
import zipfile

RUNTIME = {
    'boringssl': ['LICENSE'],
    'com_google_absl': ['LICENSE'],
    'com_google_highway': ['LICENSE', 'LICENSE-BSD3'],
    'com_google_protobuf': ['LICENSE', 'third_party/utf8_range/LICENSE'],
    'com_googlesource_code_re2': ['LICENSE'],
    'curl': ['COPYING'],
    'ducc': ['LICENSE', 'src/ducc0/fft/fft.h', 'src/ducc0/infra/threading.cc'],
    'eigen_archive': ['COPYING.README', 'COPYING.MPL2', 'COPYING.BSD', 'COPYING.APACHE', 'COPYING.MINPACK'],
    'farmhash_archive': ['COPYING'],
    'fft2d': ['readme.txt', 'readme2d.txt'],
    'gemmlowp': ['LICENSE'],
    'gif': ['COPYING'],
    'highwayhash': ['LICENSE'],
    'hwloc': ['COPYING'],
    'icu': ['icu4c/LICENSE'],
    'jpegxl': ['LICENSE'],
    'jsoncpp_git': ['LICENSE'],
    'libjpeg_turbo': ['LICENSE.md', 'README.ijg'],
    'libwebp': ['COPYING'],
    'llvm-project': ['llvm/LICENSE.TXT', 'mlir/LICENSE.TXT', 'llvm/lib/Support/BLAKE3/LICENSE'],
    'ml_dtypes_py': ['LICENSE', 'LICENSE.eigen'],
    'onednn': ['LICENSE'],
    'org_brotli': ['LICENSE'],
    'org_xprof': ['LICENSE'],
    'png': ['LICENSE'],
    'riegeli': ['LICENSE'],
    'skcms': ['LICENSE'],
    'snappy': ['COPYING'],
    'sobol_data': ['LICENSE'],
    'tsl': ['LICENSE'],
    'xla': ['LICENSE'],
    'zlib': ['LICENSE'],
}
TOOL_GAPS = {
    'python_3_12_x86_64-unknown-linux-gnu':
        'Upstream install_only preserves CPython/pip notices but omits the full standalone dependency notice collection.',
    'tar-build-tool': 'The upstream binary archive omits a standalone GNU tar license file.',
    'xz-build-tool': 'The upstream binary archive omits standalone XZ/liblzma license files.',
}

def section(label, data):
    return '\n--- ' + label + ' ---\n' + data.decode('utf-8', errors='replace') + '\n'

def notice_name(name):
    base = Path(name).name.lower()
    return (base.startswith(('license', 'licence', 'copying', 'copyright', 'notice', 'patents')) or
            base.endswith(('-copyright', 'license.terms')) or
            '/jdk/legal/' in name or base in {'assembly_exception', 'disclaimer'})

def archive_notices(path):
    chunks = []
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if not name.endswith('/') and notice_name(name):
                    chunks.append(section(name, archive.read(name)))
            if 'A-server.jar' in archive.namelist():
                with zipfile.ZipFile(io.BytesIO(archive.read('A-server.jar'))) as server:
                    for name in server.namelist():
                        if not name.endswith('/') and notice_name(name):
                            chunks.append(section('A-server.jar/' + name, server.read(name)))
    elif tarfile.is_tarfile(path):
        with tarfile.open(path, 'r|*') as archive:
            for item in archive:
                if item.isfile() and notice_name(item.name):
                    chunks.append(section(item.name, archive.extractfile(item).read()))
    return chunks

def collect(source, pins):
    external = source / ('bazel-' + source.name) / 'external'
    rows = json.loads((source / 'bazel-bin/ffb/c_api_static.ffb-link.json').read_text())
    for row in rows:
        repository = row['owner'].split('//', 1)[0].lstrip('@')
        if (row['libraries'] or row['flags']) and repository not in {'', 'net_zstd', 'org_sqlite', *RUNTIME}:
            raise SystemExit('Review newly linked TensorFlow owner before assigning licenses: ' + row['owner'])
    chunks = [
        'TENSORFLOW STATIC C API RUNTIME NOTICES\n',
        'DUCC FFT selects BSD; zstd and Highway select BSD; JsonCpp selects MIT.\n'
        'Preserved repository notices can also describe code outside the selected runtime subset.\n',
    ]
    for name in ['LICENSE', 'third_party/icu/data/LICENSE']:
        chunks.append(section('tensorflow/' + name, (source / name).read_bytes()))
    for repository, paths in RUNTIME.items():
        for path in paths:
            chunks.append(section(repository + '/' + path, (external / repository / path).read_bytes()))
    zstd = next(entry for entry in pins['files'] if entry['repository'] == 'net_zstd')
    with zipfile.ZipFile(source / zstd['path']) as archive:
        for path in ['zstd-1.5.7/LICENSE', 'zstd-1.5.7/COPYING']:
            chunks.append(section('net_zstd/' + path, archive.read(path)))
    sqlite = (external / 'org_sqlite/sqlite3.h').read_text()
    dedication = re.search(r'/\*.*?disclaims copyright.*?\*/', sqlite[:16384], re.DOTALL)
    if not dedication:
        raise SystemExit('SQLite public-domain notice markers changed')
    chunks.append(section('org_sqlite/public-domain-dedication', dedication.group(0).encode()))
    permission = Path(__file__).parent / 'OOURA-PERMISSION.txt'
    chunks.append(section('fft2d/author-distribution-clarification', permission.read_bytes()))
    output = source / '_ffb-notices'
    output.mkdir(exist_ok=True)
    (output / 'runtime.txt').write_text(''.join(chunks))

    tools = [
        'BUILD TOOLS AND OTHER PRESERVED SOURCE INPUTS\n'
        'These inputs are separate from the libraries linked into FFmpeg.\n'
        'The source inventory records their exact upstream origin, role and hash.\n'
        'Embedded notices are retained below; upstream omissions are identified explicitly.\n',
    ]
    runtime_repositories = {'net_zstd', 'org_sqlite', *RUNTIME}
    for entry in pins['files']:
        if entry['repository'] in runtime_repositories or entry['kind'] == 'metadata':
            continue
        tools.append('\n== ' + entry['repository'] + ' (' + entry['kind'] + ') ==\n' + entry['origin'] + '\n')
        tools.extend(archive_notices(source / entry['path']))
        gap = TOOL_GAPS.get(entry['repository'])
        if gap:
            tools.append('NOTICE COVERAGE: ' + gap + '\n')
        if 'sysroot' in entry['repository'] or 'ubuntu18' in entry['repository']:
            tools.append('NOTICE COVERAGE: the sysroot includes a libomp notice but omits a package manifest and complete package notices.\n')
    tinfo = next(entry for entry in pins['files'] if entry['repository'] == 'llvm-libtinfo-notice')
    tools.append(section('llvm-libtinfo/copyright.txt', (source / tinfo['path']).read_bytes()))
    (output / 'tool-inputs.txt').write_text(''.join(tools))
