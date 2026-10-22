#include <flite/flite.h>
#include <stddef.h>

extern cst_voice *register_cmu_time_awb(const char *voice_directory);
extern void unregister_cmu_time_awb(cst_voice *voice);

int main(void)
{
    flite_init();
    cst_voice *voice = register_cmu_time_awb(NULL);
    if (!voice)
        return 1;
    cst_wave *wave = flite_text_to_wave(
        "The time is now, exactly twelve, in the afternoon.", voice);
    if (!wave || wave->num_samples < 1000 || wave->sample_rate < 8000)
        return 2;
    double energy = 0;
    for (int i = 0; i < wave->num_samples * wave->num_channels; ++i)
        energy += (double)wave->samples[i] * wave->samples[i];
    delete_wave(wave);
    unregister_cmu_time_awb(voice);
    return energy > 1000000 ? 0 : 3;
}
