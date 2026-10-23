"""Select exact native compiler archives without changing the TensorFlow target."""
from pathlib import Path

ORIGINAL = "def _file_to_library_flag(file):\n    lib_prefix = \"lib\"\n    if file.basename.startswith(lib_prefix):\n        library_name = file.basename.replace(\".\" + file.extension, \"\")\n        library_flag = \"-l\" + library_name[len(lib_prefix):]\n    else:\n        library_flag = file.path\n\n    return library_flag\n\n"
STATIC = "def _file_to_library_flag(file):\n    if file.basename in [\"libstdc++.a\", \"libstdc++.so\"]:\n        return \"-l:libstdc++.a\"\n    if file.basename == \"libstdc++fs.a\":\n        return \"-l:libstdc++fs.a\"\n    lib_prefix = \"lib\"\n    if file.basename.startswith(lib_prefix):\n        library_name = file.basename.replace(\".\" + file.extension, \"\")\n        library_flag = \"-l\" + library_name[len(lib_prefix):]\n    else:\n        library_flag = file.path\n\n    return library_flag\n\n"


def select(output_base: Path, shared: bool) -> bool:
    path = output_base / 'external/rules_ml_toolchain/third_party/rules_cc_toolchain/features/features.bzl'
    if not path.is_file():
        return False
    text = path.read_text()
    counts = (text.count(ORIGINAL), text.count(STATIC))
    if counts not in {(1, 0), (0, 1)}:
        raise SystemExit('Review native C++ library-selection helper before changing it: ' + str(path))
    current = ORIGINAL if counts[0] else STATIC
    chosen = STATIC if shared else ORIGINAL
    if current != chosen:
        path.write_text(text.replace(current, chosen, 1))
    return True


def verify(query: dict) -> None:
    actions = [action for action in query.get('actions', []) if action.get('mnemonic') == 'CppLink']
    if len(actions) != 1:
        raise SystemExit('Expected one native TensorFlow CppLink for compiler runtime verification')
    arguments = actions[0]['arguments']
    required = {'-l:libstdc++.a', '-l:libstdc++fs.a', '-lgcc_s'}
    forbidden = {'-lstdc++', '-lstdc++fs', '-l:libstdc++.so', '-static-libgcc'}
    if not required.issubset(arguments) or forbidden.intersection(arguments):
        raise SystemExit('Native TensorFlow link did not select exact C++ archives and shared unwinder')
    print('Native TensorFlow compiler runtime: exact libstdc++/filesystem archives and shared unwinder selected', flush=True)
