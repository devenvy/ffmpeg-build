#include <AL/al.h>
#include <AL/alc.h>
#include <AL/alext.h>
#include <assert.h>
#include <math.h>
#include <stdio.h>

enum { RATE = 48000, FRAMES = 4800 };
static double energy(const float *samples) {
    double total = 0;
    unsigned crossings = 0;
    for (int i = 0; i < FRAMES; ++i) {
        assert(isfinite(samples[i * 2]));
        assert(isfinite(samples[i * 2 + 1]));
        assert(fabs(samples[i * 2] - samples[i * 2 + 1]) < 0.00001);
        total += samples[i * 2] * samples[i * 2];
        if (i && samples[i * 2] > 0 && samples[(i - 1) * 2] <= 0) ++crossings;
    }
    assert(crossings >= 95 && crossings <= 105);
    assert(total > 0.01);
    return total;
}
int main(void) {
    LPALCLOOPBACKOPENDEVICESOFT open_loopback =
        (LPALCLOOPBACKOPENDEVICESOFT)alcGetProcAddress(NULL, "alcLoopbackOpenDeviceSOFT");
    LPALCRENDERSAMPLESSOFT render =
        (LPALCRENDERSAMPLESSOFT)alcGetProcAddress(NULL, "alcRenderSamplesSOFT");
    assert(open_loopback && render);
    ALCdevice *device = open_loopback(NULL);
    assert(device);
    const ALCint attributes[] = {ALC_FORMAT_CHANNELS_SOFT, ALC_STEREO_SOFT,
        ALC_FORMAT_TYPE_SOFT, ALC_FLOAT_SOFT, ALC_FREQUENCY, RATE,
        ALC_HRTF_SOFT, ALC_FALSE, ALC_OUTPUT_LIMITER_SOFT, ALC_FALSE, 0};
    ALCcontext *context = alcCreateContext(device, attributes);
    assert(context && alcMakeContextCurrent(context));
    ALshort tone[RATE];
    for (int i = 0; i < RATE; ++i) tone[i] = (ALshort)(16000 * sin(i * 2.0 * 3.141592653589793 * 1000 / RATE));
    ALuint buffer, source;
    alGenBuffers(1, &buffer);
    alBufferData(buffer, AL_FORMAT_MONO16, tone, sizeof(tone), RATE);
    alGenSources(1, &source);
    alSourcei(source, AL_BUFFER, buffer);
    alSourcei(source, AL_SOURCE_RELATIVE, AL_TRUE);
    alSourcef(source, AL_ROLLOFF_FACTOR, 0);
    alSourcef(source, AL_GAIN, 0.25f);
    alSourcePlay(source);
    float samples[FRAMES * 2];
    render(device, samples, FRAMES);
    render(device, samples, FRAMES);
    double quiet = energy(samples);
    alSourcef(source, AL_GAIN, 0.5f);
    render(device, samples, FRAMES);
    render(device, samples, FRAMES);
    double loud = energy(samples);
    assert(loud / quiet > 3.8 && loud / quiet < 4.2);
    assert(alGetError() == AL_NO_ERROR && alcGetError(device) == ALC_NO_ERROR);
    alSourceStop(source);
    alDeleteSources(1, &source);
    alDeleteBuffers(1, &buffer);
    assert(alcMakeContextCurrent(NULL));
    alcDestroyContext(context);
    assert(alcCloseDevice(device));
    puts("OpenAL: owned stereo loopback samples, 1kHz tone, gain ratio and object lifetime passed");
    return 0;
}
