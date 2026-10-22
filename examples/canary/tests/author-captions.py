from pathlib import Path
import base64
import hashlib
import json

ROOT = Path(__file__).parent

def crc(data, width, polynomial, initial):
    value = initial
    mask = (1 << width) - 1
    for byte in data:
        value ^= byte << (width - 8)
        for _ in range(8):
            value = ((value << 1) ^ (polynomial if value & (1 << (width - 1)) else 0)) & mask
    return value

def arib(group, payload):
    data = bytes([group << 2, 0, 0]) + len(payload).to_bytes(2, 'big') + payload
    data += crc(data, 16, 0x1021, 0).to_bytes(2, 'big')
    assert crc(data, 16, 0x1021, 0) == 0
    return bytes.fromhex('80fff0') + data

management = arib(0, bytes.fromhex('3f01006a706e80000000'))
body = bytes.fromhex('0c890e') + b'FFB'
statement = arib(1, b'\x3f' + (5 + len(body)).to_bytes(3, 'big') + b'\x1f\x20' + len(body).to_bytes(3, 'big') + body)
clear = arib(1, bytes.fromhex('3f0000061f200000010c'))
assert management.hex() == '80fff0000000000a3f01006a706e800000001cb0'
assert statement.hex() == '80fff0040000000f3f00000b1f200000060c890e464642387f'

def section(table, payload):
    result = bytes([table]) + (0xb000 | (len(payload) + 4)).to_bytes(2, 'big') + payload
    result += crc(result, 32, 0x04c11db7, 0xffffffff).to_bytes(4, 'big')
    assert crc(result, 32, 0x04c11db7, 0xffffffff) == 0
    return b'\x00' + result

def packets(pid, payload, counter):
    result = bytearray()
    first = True
    while payload:
        chunk, payload = payload[:184], payload[184:]
        header = bytes([0x47, (0x40 if first else 0) | (pid >> 8), pid & 255])
        if len(chunk) < 184:
            length = 183 - len(chunk)
            adaptation = bytes([length]) + (b'\x00' + b'\xff' * (length - 1) if length else b'')
            packet = header + bytes([0x30 | (counter & 15)]) + adaptation + chunk
        else:
            packet = header + bytes([0x10 | (counter & 15)]) + chunk
        assert len(packet) == 188
        result += packet
        counter += 1
        first = False
    return result, counter

def pes(payload, pts):
    stamp = bytes([0x21 | (((pts >> 30) & 7) << 1), (pts >> 22) & 255,
                   ((pts >> 14) & 254) | 1, (pts >> 7) & 255, ((pts << 1) & 254) | 1])
    return b'\x00\x00\x01\xbd' + (len(payload) + 8).to_bytes(2, 'big') + b'\x80\x80\x05' + stamp + payload

def transport(descriptors, payloads):
    pat = section(0, bytes.fromhex('0001c100000001e100'))
    pmt = section(2, bytes.fromhex('0001c10000fffff00006e101') + (0xf000 | len(descriptors)).to_bytes(2, 'big') + descriptors)
    output = bytearray()
    for _ in range(3):
        output += packets(0, pat, 0)[0]
        output += packets(0x100, pmt, 0)[0]
    counter = 0
    for pts, payload in payloads:
        fragment, counter = packets(0x101, pes(payload, pts), counter)
        output += fragment
    output += packets(0x1fff, b'\xff' * 184, 0)[0] * 8
    return output

ROOT.joinpath('arib.ts').write_bytes(transport(bytes.fromhex('520130fd020008'), [(0, management), (90000, statement), (180000, clear)]))

HAMMING = [0x15,0x02,0x49,0x5e,0x64,0x73,0x38,0x2f,0xd0,0xc7,0x8c,0x9b,0xa1,0xb6,0xfd,0xea]
def odd(byte):
    return byte | (0x80 if byte.bit_count() % 2 == 0 else 0)
def reverse(byte):
    return int(f'{byte:08b}'[::-1], 2)
def teletext(page, row, text=b''):
    address = (row << 3) | 1
    data = bytearray([HAMMING[address & 15], HAMMING[address >> 4]])
    if row == 0:
        data += bytes([HAMMING[page & 15], HAMMING[page >> 4], HAMMING[0], HAMMING[0], HAMMING[0], HAMMING[8], HAMMING[1], HAMMING[0]])
        data += bytes([odd(32)] * 32)
    else:
        data += bytes(odd(byte) for byte in text.ljust(40, b' '))
    assert len(data) == 42
    return bytes([3,44,0x20 | (7 + row),0xe4]) + bytes(reverse(byte) for byte in data)
payload = b'\x10' + teletext(0,0) + teletext(0,1,b'FFB authored Teletext') + teletext(1,0)
assert len(payload) == 139
ROOT.joinpath('teletext.ts').write_bytes(transport(bytes.fromhex('56056a706e1000'), [(90000, payload), (180000, payload)]))
print('Authored ARIB and Teletext MPEG-TS fixtures; CRCs and packet sizes checked')


manifest = []
for name in ['arib', 'teletext']:
    path = ROOT / (name + '.ts')
    data = path.read_bytes()
    (ROOT / (name + '.base64')).write_text(base64.b64encode(data).decode() + '\n')
    manifest.append({'name': name, 'sha': hashlib.sha256(data).hexdigest()})
    path.unlink()
(ROOT / 'caption-fixtures.json').write_text(json.dumps(manifest, indent=2) + '\n')
