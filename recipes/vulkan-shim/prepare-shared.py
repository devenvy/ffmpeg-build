"""Adapt the pinned native generator to a driver-optional Windows DLL."""
from pathlib import Path


def replace_once(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise SystemExit(f"{path}: expected exactly one reviewed source fragment: {before!r}")
    path.write_text(text.replace(before, after))


replace_once(
    Path('CMakeLists.txt'),
    'add_library(vulkan-shim STATIC "${GENERATED_LOADER}")',
    'add_library(vulkan-shim SHARED "${GENERATED_LOADER}")',
)
replace_once(
    Path('CMakeLists.txt'),
    '  VERSION "${VK_VERSION_STRING}")',
    '  VERSION "${VK_VERSION_STRING}"\n'
    '  PREFIX ""\n'
    '  RUNTIME_OUTPUT_NAME "ffb-vulkan-shim"\n'
    '  ARCHIVE_OUTPUT_NAME "vulkan-1")',
)

# A DLL constructor runs under the Windows loader lock. Defer LoadLibraryExA
# until an ordinary API call, with synchronization before every pointer read.
# Cache a failed first load as the native constructor did; never require a driver
# just to load FFmpeg or this shim. Static mode keeps its original generator.
replace_once(Path('gen_shim.py'), '__attribute__((constructor))\n', '')
replace_once(
    Path('gen_shim.py'),
    '#undef dlsym\n#endif\n}\n',
    '#undef dlsym\n#endif\n}\n\n'
    'static INIT_ONCE ffb_once = INIT_ONCE_STATIC_INIT;\n'
    'static BOOL CALLBACK ffb_init_once(PINIT_ONCE once, PVOID parameter, PVOID *context) {\n'
    '    (void)once; (void)parameter; (void)context;\n'
    '    init();\n'
    '    return TRUE;\n'
    '}\n',
)
replace_once(
    Path('gen_shim.py'),
    '    print(f"{ret_type} VKAPI_CALL {name}({decl_params}) {{")',
    '    print(f"{ret_type} VKAPI_CALL {name}({decl_params}) {{")\n'
    '    print("    InitOnceExecuteOnce(&ffb_once, ffb_init_once, NULL, NULL);")',
)
