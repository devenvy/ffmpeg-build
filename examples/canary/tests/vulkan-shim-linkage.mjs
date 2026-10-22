import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
assert.equal(process.platform, 'win32');
const directory = dirname(ffmpeg);
const DOS_MAGIC = 0x5a4d;
const PE_POINTER = 0x3c;
const PE_MAGIC = 0x4550;
const PE_HEADER_BYTES = 24;
const OPTIONAL_SIZE_OFFSET = 20;
const SECTION_COUNT_OFFSET = 6;
const SECTION_BYTES = 40;
const SECTION_ADDRESS_OFFSET = 12;
const SECTION_VIRTUAL_SIZE_OFFSET = 8;
const SECTION_RAW_SIZE_OFFSET = 16;
const SECTION_RAW_POINTER_OFFSET = 20;
const PE64_MAGIC = 0x20b;
const PE64_DIRECTORY_OFFSET = 112;
const PE32_DIRECTORY_OFFSET = 96;
const IMPORT_DIRECTORY_OFFSET = 8;
const IMPORT_DESCRIPTOR_BYTES = 20;
const IMPORT_NAME_OFFSET = 12;
const MAX_IMPORTS = 512;
const MAX_IMPORT_NAME = 256;
const TIMEOUT = 30000;
const MAX_OUTPUT = 4194304;
const FRAME_COUNT = 3;
const WIDTH = 16;
const HEIGHT = 16;
const RGB_BYTES = 3;
const BLUE_OFFSET = 2;
const MIN_RED = 240;
const MAX_OTHER = 16;

function imports(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.readUInt16LE(0), DOS_MAGIC);
  const pe = bytes.readUInt32LE(PE_POINTER);
  assert.equal(bytes.readUInt32LE(pe), PE_MAGIC);
  const optional = pe + PE_HEADER_BYTES;
  const sections = optional + bytes.readUInt16LE(pe + OPTIONAL_SIZE_OFFSET);
  const count = bytes.readUInt16LE(pe + SECTION_COUNT_OFFSET);
  const rvaOffset = (rva) => {
    for (let i = 0; i < count; i++) {
      const section = sections + i * SECTION_BYTES;
      const address = bytes.readUInt32LE(section + SECTION_ADDRESS_OFFSET);
      const size = Math.max(
        bytes.readUInt32LE(section + SECTION_VIRTUAL_SIZE_OFFSET),
        bytes.readUInt32LE(section + SECTION_RAW_SIZE_OFFSET),
      );
      if (rva >= address && rva < address + size) {
        return bytes.readUInt32LE(section + SECTION_RAW_POINTER_OFFSET) + rva - address;
      }
    }
    return assert.fail(`Unmapped PE RVA ${rva} in ${path}`);
  };
  const directories =
    optional +
    (bytes.readUInt16LE(optional) === PE64_MAGIC ? PE64_DIRECTORY_OFFSET : PE32_DIRECTORY_OFFSET);
  const importRva = bytes.readUInt32LE(directories + IMPORT_DIRECTORY_OFFSET);
  if (!importRva) {
    return [];
  }
  const result = [];
  let descriptor = rvaOffset(importRva);
  for (let i = 0; i < MAX_IMPORTS; i++, descriptor += IMPORT_DESCRIPTOR_BYTES) {
    const nameRva = bytes.readUInt32LE(descriptor + IMPORT_NAME_OFFSET);
    if (!nameRva) {
      return result;
    }
    const offset = rvaOffset(nameRva);
    const end = bytes.indexOf(0, offset);
    assert.ok(end >= offset && end - offset < MAX_IMPORT_NAME);
    result.push(bytes.toString('ascii', offset, end).toLowerCase());
  }
  return assert.fail('PE import directory has no terminator');
}

const selectedShared = existsSync(join(directory, 'ffb-vulkan-shim.dll'));
let foundShimImport = false;
for (const name of readdirSync(directory).filter((candidate) =>
  /\.(?:dll|exe)$/i.test(candidate),
)) {
  const linked = imports(join(directory, name));
  assert.ok(
    !linked.some((dependency) =>
      /^(?:libgcc_s|libstdc\+\+|libwinpthread|libc\+\+|libunwind|vulkan-1)/i.test(dependency),
    ),
    `${name}: ${linked}`,
  );
  if (linked.includes('ffb-vulkan-shim.dll')) {
    foundShimImport = true;
  }
  if (name === 'ffb-vulkan-shim.dll') {
    assert.deepEqual(linked.toSorted(), ['kernel32.dll', 'msvcrt.dll']);
  }
}
assert.equal(foundShimImport, selectedShared);

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
assert.match(run(['-filters']).toString(), /\bwhisper\b/);
const pixels = run([
  '-f',
  'lavfi',
  '-i',
  'color=red:size=16x16:rate=3:duration=1',
  '-pix_fmt',
  'rgb24',
  '-f',
  'rawvideo',
  '-',
]);
assert.equal(pixels.length, FRAME_COUNT * WIDTH * HEIGHT * RGB_BYTES);
for (let i = 0; i < pixels.length; i += RGB_BYTES) {
  assert.ok(
    pixels[i] > MIN_RED && pixels[i + 1] < MAX_OTHER && pixels[i + BLUE_OFFSET] < MAX_OTHER,
  );
}
console.log(
  `Windows ${selectedShared ? 'shared' : 'static'} Vulkan shim: packaged PE ownership, driver-optional imports, Whisper availability and authored CPU frames through EOF passed`,
);
