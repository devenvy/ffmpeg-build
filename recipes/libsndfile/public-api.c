#include <sndfile.h>
#include <math.h>
#include <stddef.h>

int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    SF_INFO info = {0};
    info.samplerate = 8000;
    info.channels = 1;
    info.format = SF_FORMAT_WAV | SF_FORMAT_PCM_16;
    float source[512], decoded[512];
    for (int i = 0; i < 512; ++i)
        source[i] = (float)(0.3 * sin(6.283185307179586 * 220 * i / 8000));
    SNDFILE *file = sf_open(argv[1], SFM_WRITE, &info);
    if (!file || sf_writef_float(file, source, 512) != 512 || sf_close(file))
        return 2;
    file = sf_open(argv[1], SFM_READ, &info);
    if (!file || info.frames != 512 || info.channels != 1 || info.samplerate != 8000)
        return 3;
    if (sf_readf_float(file, decoded, 512) != 512 || sf_readf_float(file, decoded, 1) != 0)
        return 4;
    for (int i = 0; i < 512; ++i) {
        if (fabsf(decoded[i] - source[i]) > 0.0001f)
            return 5;
    }
    return sf_close(file) ? 6 : 0;
}
