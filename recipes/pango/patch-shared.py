from pathlib import Path

path = Path('pango/meson.build')
text = path.read_text()
for target, indent in [('libpango', ''), ('libpangoft2', '  '), ('libpangocairo', '  ')]:
    start = indent + target + ' = library(\n'
    assert text.count(start) == 1, target
    begin = text.index(start)
    end = text.index('\n' + indent + ')', begin)
    block = text[begin:end]
    old = 'link_args: common_ldflags'
    assert block.count(old) == 1, target
    new = old + " + ['-Wl,--version-script=' + (meson.project_source_root() / 'ffb-public-api.map')]"
    text = text[:begin] + block.replace(old, new) + text[end:]
path.write_text(text)
