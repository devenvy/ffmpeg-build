#include <pthread.h>
#include <stdint.h>
#include <string.h>

extern "C" void ffb_davs2_call16(uint8_t *source, uint8_t *destination);
extern "C" void ffb_davs2_call32(uint8_t *source, uint8_t *destination);

static void *worker(void *argument)
{
    alignas(32) uint8_t reference[512];
    alignas(32) uint8_t destination[32 * 32];
    memset(reference, 128, sizeof(reference));
    memset(destination, 0, sizeof(destination));
    if (argument)
        ffb_davs2_call16(reference + 256, destination);
    else
        ffb_davs2_call32(reference + 256, destination);
    for (unsigned int i = 0; i < sizeof(destination); ++i) {
        if (destination[i] != 128)
            return (void *)(uintptr_t)1;
    }
    return NULL;
}

int main(int argc, char **argv)
{
    (void)argv;
    if (!__builtin_cpu_supports("avx2"))
        return 77;
    pthread_t thread;
    void *result;
    if (pthread_create(&thread, NULL, worker, argc > 1 ? (void *)(uintptr_t)1 : NULL))
        return 2;
    if (pthread_join(thread, &result))
        return 3;
    return result ? 1 : 0;
}
