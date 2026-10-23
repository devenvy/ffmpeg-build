#include <aribcaption/context.hpp>
#include "allocator-support.h"
static int exercise_public_allocator(int, char **) {
    begin_allocator_tracking();
    aribcaption::Context value;
    allocator_tracking = false;
    return 0;
}
