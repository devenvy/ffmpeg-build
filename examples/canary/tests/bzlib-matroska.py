"""Author a bzlib-compressed Matroska PCM track from raw signed 16-bit PCM on stdin."""
import bz2
import struct
import sys


def element(identifier, payload):
    for width in range(1, 9):
        if len(payload) < (1 << (7 * width)) - 1:
            size = ((1 << (7 * width)) | len(payload)).to_bytes(width, 'big')
            return bytes.fromhex(identifier) + size + payload
    raise ValueError('Payload is too large')


def uint(identifier, value):
    return element(identifier, value.to_bytes(max(1, (value.bit_length() + 7) // 8), 'big'))


header = element('1A45DFA3', uint('4286', 1) + uint('42F7', 1) + uint('42F2', 4) +
                 uint('42F3', 8) + element('4282', b'matroska') + uint('4287', 4) + uint('4285', 2))
info = element('1549A966', uint('2AD7B1', 1000000) + element('4D80', b'ffb-authored') +
               element('5741', b'ffb-authored'))
audio = element('E1', element('B5', struct.pack('>d', 16000)) + uint('9F', 1) + uint('6264', 16))
compression = element('6D80', element('6240', element('5034', uint('4254', 1))))
track = element('AE', uint('D7', 1) + uint('73C5', 1) + uint('83', 2) +
                element('86', b'A_PCM/INT/LIT') + audio + compression)
payload = b'not-a-bzip2-stream' if '--corrupt' in sys.argv else bz2.compress(sys.stdin.buffer.read())
cluster = element('1F43B675', uint('E7', 0) + element('A3', b'\x81\x00\x00\x80' + payload))
sys.stdout.buffer.write(header + element('18538067', info + element('1654AE6B', track) + cluster))
