"""Keep upstream's independent decoder processes beside their shared owner."""
from pathlib import Path

helper = Path('lib/libv4lconvert/helper.c')
text = helper.read_text()
old = '#include <stdio.h>'
new = '#define _GNU_SOURCE\n#include <dlfcn.h>\n#include <limits.h>\n#include <stdio.h>'
if text.count(old) != 1:
    raise SystemExit('Review the pinned libv4lconvert helper includes')
text = text.replace(old, new)
old = 'static int v4lconvert_helper_start('
new = r'''
/* Resolve the module while its original loader path is still meaningful.
 * All path work completes before fork; the child retains native execl/FD setup. */
static char ffb_helper_directory[PATH_MAX];
static void __attribute__((constructor)) ffb_helper_owner(void)
{
    Dl_info info;
    char owner[PATH_MAX];
    if (!dladdr((void *)&ffb_helper_owner, &info) || !info.dli_fname ||
        !realpath(info.dli_fname, owner))
        return;
    char *slash = strrchr(owner, '/');
    if (!slash)
        return;
    if (slash == owner)
        slash[1] = 0;
    else
        *slash = 0;
    size_t size = strlen(owner);
    if (size < sizeof(ffb_helper_directory))
        memcpy(ffb_helper_directory, owner, size + 1);
}

static int v4lconvert_helper_start('''
if text.count(old) != 1:
    raise SystemExit('Review the pinned libv4lconvert helper entry')
text = text.replace(old, new)
old = '\tif (pipe(data->decompress_in_pipe)) {'
new = r'''
    char executable[PATH_MAX];
    const char *name = strrchr(helper, '/');
    if (!name || !ffb_helper_directory[0]) {
        errno = ENOENT;
        V4LCONVERT_ERR("cannot resolve the bundled decoder owner\n");
        return -1;
    }
    int length = snprintf(executable, sizeof(executable), "%s/%s",
                          ffb_helper_directory, name + 1);
    if (length < 0 || (size_t)length >= sizeof(executable)) {
        errno = ENAMETOOLONG;
        V4LCONVERT_ERR("bundled decoder path is too long\n");
        return -1;
    }
    helper = executable;
\tif (pipe(data->decompress_in_pipe)) {'''.replace('\\t', '\t')
if text.count(old) != 1:
    raise SystemExit('Review the pinned libv4lconvert helper pipe boundary')
helper.write_text(text.replace(old, new))
meson = Path('lib/libv4lconvert/meson.build')
text = meson.read_text()
old = '    dep_librt,\n'
if text.count(old) != 1:
    raise SystemExit('Review the native libv4lconvert dependency list')
meson.write_text(text.replace(old, old + "    cc.find_library('dl'),\n"))
