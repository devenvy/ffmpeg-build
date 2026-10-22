#include <rubberband/RubberBandLiveShifter.h>
#include <rubberband/RubberBandStretcher.h>
#include <cmath>
#include <iostream>
#include <map>
#include <memory>
#include <vector>

using Stretcher = RubberBand::RubberBandStretcher;
using Shifter = RubberBand::RubberBandLiveShifter;

class Logger final : public Stretcher::Logger, public Shifter::Logger {
public:
    unsigned calls = 0;
    void log(const char *) override { ++calls; }
    void log(const char *, double) override { ++calls; }
    void log(const char *, double, double) override { ++calls; }
};

int main() {
    constexpr size_t rate = 48000;
    constexpr size_t frames = 4096;
    auto logger = std::make_shared<Logger>();
    Stretcher::setDefaultDebugLevel(1);
    Stretcher stretch(rate, 1, logger, Stretcher::OptionProcessOffline);
    stretch.setDebugLevel(2);
    stretch.setTimeRatio(1.0);
    stretch.setPitchScale(1.0);
    stretch.setExpectedInputDuration(frames);
    stretch.setKeyFrameMap(std::map<size_t, size_t>{{0, 0}, {frames, frames}});
    std::vector<float> input(frames), output(frames * 2);
    for (size_t i = 0; i < frames; ++i) {
        input[i] = static_cast<float>(0.1 * std::sin(6.283185307179586 * 997 * i / rate));
    }
    const float *inputs[] = {input.data()};
    float *outputs[] = {output.data()};
    stretch.study(inputs, frames, true);
    stretch.process(inputs, frames, true);
    size_t retrieved = 0;
    while (stretch.available() > 0) {
        const size_t count = stretch.retrieve(outputs, output.size());
        if (!count) return 1;
        retrieved += count;
        for (size_t i = 0; i < count; ++i) if (!std::isfinite(output[i])) return 2;
    }
    if (retrieved != frames) return 3;
    auto increments = stretch.getOutputIncrements();
    auto resets = stretch.getPhaseResetCurve();
    auto exact = stretch.getExactTimePoints();
    Shifter shift(rate, 1, logger, Shifter::OptionWindowShort);
    shift.setDebugLevel(2);
    shift.setPitchScale(1.0);
    const size_t block = shift.getBlockSize();
    if (!block || block > frames) return 4;
    shift.shift(inputs, outputs);
    for (size_t i = 0; i < block; ++i) if (!std::isfinite(output[i])) return 5;
    if (!logger->calls) return 6;
    std::cout << "Rubber Band external C++ API, shared loggers, map/vector ownership and live shift passed: "
              << increments.size() + resets.size() + exact.size() << '\n';
}
