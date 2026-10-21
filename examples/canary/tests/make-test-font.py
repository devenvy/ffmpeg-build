"""Regenerate the authored geometric test font with fontTools 4.60.1; no third-party glyphs."""
import base64
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

units = 1000
builder = FontBuilder(units, isTTF=True)
order = ['.notdef', 'space', 'F', 'B', 'alef', 'bet']
builder.setupGlyphOrder(order)
builder.setupCharacterMap({32: 'space', 70: 'F', 66: 'B', 0x05D0: 'alef', 0x05D1: 'bet'})
shapes = {
    '.notdef': [(80, 0), (80, 700), (520, 700), (520, 0)],
    'space': [],
    'F': [(80, 0), (80, 700), (520, 700), (520, 600), (200, 600),
          (200, 400), (450, 400), (450, 300), (200, 300), (200, 0)],
    'B': [(80, 0), (80, 700), (400, 700), (520, 600), (520, 430),
          (450, 350), (550, 250), (550, 100), (430, 0)],
    'alef': [(80, 0), (300, 700), (520, 0)],
    'bet': [(80, 0), (80, 140), (400, 140), (400, 560), (80, 560),
            (80, 700), (520, 700), (520, 0)],
}
glyphs = {}
for name in order:
    pen = TTGlyphPen(None)
    points = shapes[name]
    if points:
        pen.moveTo(points[0])
        for point in points[1:]:
            pen.lineTo(point)
        pen.closePath()
    glyphs[name] = pen.glyph()
builder.setupGlyf(glyphs)
builder.setupHorizontalMetrics({name: (600, 0) for name in order})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({'familyName': 'FFB Test', 'styleName': 'Regular',
    'uniqueFontIdentifier': 'FFBTest-Regular-1', 'fullName': 'FFB Test Regular',
    'psName': 'FFBTest-Regular', 'version': 'Version 1.0',
    'copyright': 'Authored for the ffmpeg-build canary; MIT license.'})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
builder.font['head'].created = 3760128000
builder.font['head'].modified = 3760128000
builder.font.recalcTimestamp = False
target = Path('/tmp/ffb-test-font.ttf')
builder.save(target)
print(base64.b64encode(target.read_bytes()).decode())
