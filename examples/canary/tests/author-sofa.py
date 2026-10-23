from pathlib import Path
import base64
import hashlib
import json
import numpy as np
import netCDF4

# Authoring tools only; maintained runtime tests consume committed fixture bytes.
ROOT = Path(__file__).parent

def generate(path, compressed):
    with netCDF4.Dataset(path, 'w', format='NETCDF4') as file:
        for name, size in [('I',1), ('C',3), ('R',2), ('E',1), ('N',32), ('M',6)]:
            file.createDimension(name, size)
        for name, value in {
            'Conventions':'SOFA', 'Version':'1.0', 'SOFAConventions':'SimpleFreeFieldHRIR',
            'SOFAConventionsVersion':'1.0', 'DataType':'FIR', 'RoomType':'free field',
            'Title':'FFB authored synthetic impulse HRTF', 'License':'CC0-1.0',
            'AuthorContact':'devenvy', 'Organization':'devenvy', 'ListenerShortName':'FFB',
        }.items():
            file.setncattr(name, value)
        def variable(name, dimensions, values, kind=None, units=None):
            result = file.createVariable(name, 'f8', dimensions, zlib=(compressed and name == 'Data.IR'), complevel=3)
            result[:] = np.asarray(values, dtype=np.float64)
            if kind:
                result.Type = kind
            if units:
                result.Units = units
            return result
        variable('ListenerPosition', ('I','C'), [[0,0,0]], 'cartesian', 'metre')
        variable('ListenerView', ('I','C'), [[1,0,0]], 'cartesian', 'metre')
        variable('ListenerUp', ('I','C'), [[0,0,1]], 'cartesian', 'metre')
        receiver = np.zeros((2,3,1))
        receiver[0,1,0] = .09
        receiver[1,1,0] = -.09
        variable('ReceiverPosition', ('R','C','I'), receiver, 'cartesian', 'metre')
        variable('EmitterPosition', ('E','C','I'), np.zeros((1,3,1)), 'cartesian', 'metre')
        variable('SourcePosition', ('M','C'), [[0,0,1],[90,0,1],[180,0,1],[270,0,1],[0,90,1],[0,-90,1]], 'spherical', 'degree, degree, metre')
        impulse = np.zeros((6,2,32))
        for direction in range(6):
            impulse[direction,0,0] = .5
            impulse[direction,1,1] = .25
        variable('Data.IR', ('M','R','N'), impulse)
        variable('Data.SamplingRate', ('I',), [48000], units='hertz')
        variable('Data.Delay', ('I','R'), [[0,0]])

metadata = {'frames':512, 'sampleRate':48000, 'hrirLength':32,
    'leftImpulse':.5, 'rightImpulse':.25, 'rightDelaySamples':1,
    'netCDF4':netCDF4.__version__, 'numpy':np.__version__, 'license':'CC0-1.0'}
for compressed in [False, True]:
    name = 'sofa-compressed' if compressed else 'sofa'
    path = ROOT / (name + '.sofa')
    generate(path, compressed)
    data = path.read_bytes()
    (ROOT / (name + '.base64')).write_text(base64.b64encode(data).decode() + '\n')
    metadata['compressedSha256' if compressed else 'sha256'] = hashlib.sha256(data).hexdigest()
    path.unlink()
(ROOT / 'sofa-fixture.json').write_text(json.dumps(metadata, indent=2) + '\n')
