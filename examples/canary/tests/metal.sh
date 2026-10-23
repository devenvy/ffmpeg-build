#!/usr/bin/env bash
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
source="nullsrc=size=96x64:rate=24:duration=1,geq=lum='32+160*mod(floor(X/8)+floor(Y/8),2)':cb=96:cr=160"

# A static checkerboard has a known pixel result in both deinterlacing modes.
# Each process must also drain its filter thread's autorelease pool successfully.
for mode in send_frame send_field; do
  frames=24
  if [[ "$mode" == send_field ]]; then frames=48; fi
  "$FFMPEG" -nostdin -v error -f lavfi -i "$source" \
    -vf "setfield=tff,yadif=mode=$mode,format=nv12" -fps_mode passthrough \
    -f rawvideo "$scratch/cpu.raw"
  "$FFMPEG" -nostdin -v error -init_hw_device videotoolbox=vt -filter_hw_device vt \
    -f lavfi -i "$source" \
    -vf "setfield=tff,format=nv12,hwupload,yadif_videotoolbox=mode=$mode,hwdownload,format=nv12" \
    -fps_mode passthrough -f rawvideo "$scratch/metal.raw"
  node - "$scratch/cpu.raw" "$scratch/metal.raw" "$frames" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [cpuPath, metalPath, frames] = process.argv.slice(2);
const cpu = fs.readFileSync(cpuPath), metal = fs.readFileSync(metalPath);
assert.equal(cpu.length, Number(frames) * 96 * 64 * 3 / 2);
assert.equal(metal.length, cpu.length);
let maximum = 0;
for (let i = 0; i < cpu.length; i++) maximum = Math.max(maximum, Math.abs(cpu[i] - metal[i]));
assert.ok(maximum <= 1, `CPU/Metal pixel difference ${maximum}`);
assert.ok(cpu.subarray(0, 96 * 64).includes(32));
assert.ok(cpu.subarray(0, 96 * 64).includes(192));
console.log(`Metal: ${frames} complete frames, CPU pixels agree within ${maximum}`);
NODE
  rm "$scratch/cpu.raw" "$scratch/metal.raw"
done

for repetition in 1 2 3; do
  "$FFMPEG" -nostdin -v error -init_hw_device videotoolbox=vt -filter_hw_device vt \
    -f lavfi -i testsrc2=size=96x64:rate=24:duration=1 \
    -vf 'setfield=tff,format=nv12,hwupload,yadif_videotoolbox,hwdownload,format=nv12' \
    -frames:v 1 -f null -
  echo "Metal early shutdown $repetition passed"
done
