#include <lensfun/lensfun.h>
#include <cstdio>
#include <cstdlib>
#include <new>

static bool tracking = false;
static unsigned hits = 0;
void *operator new(std::size_t size) {
    void *memory = std::malloc(size ? size : 1);
    if (!memory) throw std::bad_alloc();
    if (tracking) ++hits;
    return memory;
}
void *operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void *memory) noexcept { std::free(memory); }
void operator delete[](void *memory) noexcept { std::free(memory); }
void operator delete(void *memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void *memory, std::size_t) noexcept { std::free(memory); }

extern "C" char *allocator_control();
int main() {
    tracking = true;
    char *control = allocator_control();
    tracking = false;
    if (hits != 1) return 1;
    delete[] control;
    hits = 0;
    lfMount mount;
    tracking = true;
    mount.AddCompat("owned-compatible-mount");
    tracking = false;
    std::printf("Lensfun public replacement allocator: hits=%u\n", hits);
    return hits ? 0 : 2;
}
