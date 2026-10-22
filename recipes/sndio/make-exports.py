from pathlib import Path
import re

header = Path('libsndio/sndio.h').read_text()
names = sorted(set(re.findall(r'\b((?:sio|mio|sioctl)_\w+)\s*\(', header)))
assert {'sio_open', 'mio_open', 'sioctl_open'} <= set(names)
Path('ffb-public-api.map').write_text('{\n  global:\n' +
    ''.join('    ' + name + ';\n' for name in names) + '  local: *;\n};\n')
