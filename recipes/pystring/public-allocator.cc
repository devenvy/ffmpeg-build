#include <pystring/pystring.h>
#include <string>
#include "allocator-support.h"
static int exercise_public_allocator(int, char **) {
    const std::string input(128, 'a');
    begin_allocator_tracking();
    const std::string output = pystring::upper(input);
    allocator_tracking = false;
    return output == std::string(128, 'A') && allocator_registered(output.data()) ? 0 : 3;
}
