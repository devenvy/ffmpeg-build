# Authored audio device checks

The audio-device linkage targets exercise FFmpeg 8/9 with static/shared OpenAL Soft and sndio,
and independent static/shared ALSA choices. Nothing needs physical audio hardware.

`audio-device-linkage.mjs` owns its ALSA configuration. The file plugin sits above the null PCM;
capture reads a nonzero deterministic signed-16-bit byte stream. OpenAL uses its real ALSA capture
backend through an owned `ALSOFT_CONF`; sndio uses `rsnd/0`, mapped explicitly to the owned software
`pcm.hw`. Both FFmpeg inputs must return exactly 4800 mono samples at 48 kHz, byte for byte.
FFmpeg's sndio output must write the same 9600 bytes. Unknown OpenAL devices and malformed sndio
PCM arguments must fail within the bounded timeout. These are configured software PCM checks,
not physical-device or sndiod-server claims.

Shared recipe builds also compile the installed public headers and libraries. OpenAL renders an
owned 1 kHz source through its loopback extension, checks finite matching stereo samples and the
expected fourfold energy change when gain doubles, then destroys every object. Sndio checks
negotiated parameters, bounded poll descriptors, read/write progress, exact software PCM samples,
stop/close and unavailable MIDI/control endpoints. The sndio export map is derived from the actual
public header; OpenAL retains its native map. Embedded ALSA and OpenAL's static C++ implementation
remain private, with the common unwinder available.

OpenAL's embedded default HRTF data remains enabled. Disabling installation of external HRTF files
does not remove that embedded data. The deterministic loopback probe explicitly disables HRTF and
the output limiter for its numerical comparison.
