#include <rubberband/RubberBandStretcher.h>
#include "allocator-support.h"
static int exercise_public_allocator(int, char **) {
    begin_allocator_tracking();
    RubberBand::RubberBandStretcher value(48000, 1);
    allocator_tracking = false;
    return 0;
}
