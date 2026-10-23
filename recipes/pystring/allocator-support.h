#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <new>

static std::atomic<bool> allocator_tracking{false};
static std::atomic<unsigned> allocator_hits{0};
static std::atomic_flag allocator_lock = ATOMIC_FLAG_INIT;
static void *allocator_owned[4096]{};
static unsigned allocator_used = 0;
static void lock_allocator() { while (allocator_lock.test_and_set(std::memory_order_acquire)) {} }
static void unlock_allocator() { allocator_lock.clear(std::memory_order_release); }
static bool allocator_registered(const void *memory) {
    lock_allocator();
    bool found = false;
    for (unsigned i = 0; i < allocator_used; ++i) if (allocator_owned[i] == memory) found = true;
    unlock_allocator();
    return found;
}
static void begin_allocator_tracking() {
    lock_allocator();
    allocator_used = 0;
    allocator_hits = 0;
    unlock_allocator();
    allocator_tracking = true;
}
void *operator new(std::size_t size) {
    void *memory = std::malloc(size ? size : 1);
    if (!memory) throw std::bad_alloc();
    if (allocator_tracking) {
        lock_allocator();
        ++allocator_hits;
        if (allocator_used < 4096) allocator_owned[allocator_used++] = memory;
        unlock_allocator();
    }
    return memory;
}
void *operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void *memory) noexcept {
    lock_allocator();
    for (unsigned i = 0; i < allocator_used; ++i) if (allocator_owned[i] == memory) allocator_owned[i] = nullptr;
    unlock_allocator();
    std::free(memory);
}
void operator delete[](void *memory) noexcept { ::operator delete(memory); }
void operator delete(void *memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void *memory, std::size_t) noexcept { ::operator delete(memory); }

extern "C" char *allocator_control();
static int exercise_public_allocator(int argc, char **argv);
int main(int argc, char **argv) {
    begin_allocator_tracking();
    char *control = allocator_control();
    allocator_tracking = false;
    if (allocator_hits != 1 || !allocator_registered(control)) return 1;
    delete[] control;
    const int result = exercise_public_allocator(argc, argv);
    allocator_tracking = false;
    std::printf("Public C++ replacement allocator: hits=%u result=%d\n", allocator_hits.load(), result);
    return result ? result : (allocator_hits ? 0 : 2);
}
