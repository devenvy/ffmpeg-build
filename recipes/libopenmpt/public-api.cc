#include <libopenmpt/libopenmpt.hpp>
#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    std::ifstream input(argv[1], std::ios::binary);
    std::ostringstream log;
    openmpt::module module(input, log, { { "load.skip_plugins", "1" } });
    if (module.get_metadata("title") != "FFB own module" || module.get_metadata_keys().empty())
        return 2;
    if (module.get_num_channels() != 4 || module.get_duration_seconds() <= 0)
        return 3;
    module.set_repeat_count(0);
    std::vector<float> samples(1024 * 2);
    std::size_t total = 0;
    double energy = 0;
    for (;;) {
        auto count = module.read_interleaved_stereo(48000, 1024, samples.data());
        if (!count)
            break;
        total += count;
        if (total > 1000000)
            return 4;
        for (std::size_t i = 0; i < count * 2; ++i) {
            if (!std::isfinite(samples[i]))
                return 5;
            energy += samples[i] * samples[i];
        }
    }
    if (total < 48000 || energy <= 1)
        return 6;
    try {
        std::istringstream invalid("not a module");
        openmpt::module rejected(invalid, log);
        return 7;
    } catch (const std::exception &) {
        return 0;
    }
}
