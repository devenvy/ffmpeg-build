#include <assert.h>
#include <dlfcn.h>

int main(int argc, char **argv) {
    assert(argc == 2);
    void *owner = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    assert(owner);
    int (*probe)(void) = (int (*)(void))dlsym(owner, "main");
    assert(probe && probe() == 0);
    assert(dlclose(owner) == 0);
    return 0;
}
