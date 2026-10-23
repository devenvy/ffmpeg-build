#include <libopenmpt/libopenmpt.hpp>
#include <sstream>
#include <vector>
#include <exception>
#include <cstdio>

static int during = -99;
struct UnwindCounter {
    ~UnwindCounter() { during = std::uncaught_exceptions(); }
};
int main() {
    const int initial = std::uncaught_exceptions();
    int inside = -99;
    bool typed = false, rethrown = false;
    std::exception_ptr saved;
    try {
        UnwindCounter counter;
        std::ostringstream log;
        std::vector<char> invalid = {0, 1, 2, 3};
        openmpt::module module(invalid, log);
    } catch (const openmpt::exception &error) {
        typed = dynamic_cast<const std::exception *>(&error) != nullptr;
        inside = std::uncaught_exceptions();
        saved = std::current_exception();
    }
    const bool retained = bool(saved);
    if (saved) {
        try { std::rethrow_exception(saved); }
        catch (const openmpt::exception &) { rethrown = true; }
    }
    saved = nullptr;
    const int after = std::uncaught_exceptions();
    std::printf("libopenmpt public exception: typed=%d retained=%d rethrow=%d initial=%d unwind=%d catch=%d after=%d\n",
                typed, retained, rethrown, initial, during, inside, after);
    return !(typed && retained && rethrown && initial == 0 && during == 1 && inside == 0 && after == 0);
}
