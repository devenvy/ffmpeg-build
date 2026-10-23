"""Expose the native static MoltenVK SDK without constructing a second loader."""
from pathlib import Path
import re
import shutil
import sys

deps = Path(sys.argv[1])
native = deps / 'lib/libMoltenVK.a'
if not native.is_file():
    raise SystemExit('Direct Vulkan requires the selected native static MoltenVK archive')
shutil.copyfile(native, deps / 'lib/libvulkan.a')
header = (deps / 'include/vulkan/vulkan_core.h').read_text()
patch = re.search(r'^#define VK_HEADER_VERSION\s+(\d+)\s*$', header, re.M)
version = re.search(r'^#define VK_HEADER_VERSION_COMPLETE\s+VK_MAKE_API_VERSION\(\s*0,\s*(\d+),\s*(\d+),', header, re.M)
if not patch or not version:
    raise SystemExit('The pinned Vulkan header no longer declares its reviewed API version')
pc = deps / 'lib/pkgconfig/vulkan.pc'
pc.parent.mkdir(parents=True, exist_ok=True)
pc.write_text(
    'prefix=${pcfiledir}/../..\n'
    'libdir=${prefix}/lib\n'
    'includedir=${prefix}/include\n\n'
    'Name: Vulkan (direct native MoltenVK)\n'
    'Description: Native static Vulkan-over-Metal implementation, without an ICD loader\n'
    f'Version: {version[1]}.{version[2]}.{patch[1]}\n'
    'Libs: -L${libdir} -lvulkan\n'
    'Libs.private: -lc++ -framework Metal -framework Foundation -framework QuartzCore '
    '-framework CoreGraphics -framework IOSurface -framework IOKit -framework AppKit\n'
    'Cflags: -I${includedir}\n'
)
