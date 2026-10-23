#include <srt/udt.h>
#include <string>
#include "allocator-support.h"
static int exercise_public_allocator(int, char **) {
    if (srt_startup()) return 3;
    const SRTSOCKET socket = srt_create_socket();
    if (socket == SRT_INVALID_SOCK) return 4;
    const std::string input(128, 'a');
    if (!srt::setstreamid(socket, input)) return 5;
    begin_allocator_tracking();
    const std::string output = srt::getstreamid(socket);
    allocator_tracking = false;
    const bool owned = allocator_registered(output.data()) && output == input;
    srt_close(socket);
    srt_cleanup();
    return owned ? 0 : 6;
}
