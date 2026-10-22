#include <xf86drm.h>
#include <drm_fourcc.h>
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int payload[] = {10, 20, 30};
    const unsigned long keys[] = {30, 10, 20};
    void *table = drmHashCreate();
    assert(table);
    for (unsigned i = 0; i < 3; ++i) assert(drmHashInsert(table, keys[i], &payload[i]) == 0);
    assert(drmHashInsert(table, keys[0], &payload[0]) == 1);
    void *value = NULL;
    for (unsigned i = 0; i < 3; ++i) {
        assert(drmHashLookup(table, keys[i], &value) == 0);
        assert(value == &payload[i]);
    }
    unsigned long key;
    unsigned count = 0;
    for (int found = drmHashFirst(table, &key, &value); found; found = drmHashNext(table, &key, &value)) {
        assert(found == 1 && value);
        unsigned i;
        for (i = 0; i < 3 && keys[i] != key; ++i) {}
        assert(i < 3 && value == &payload[i]);
        ++count;
    }
    assert(count == 3);
    assert(drmHashDelete(table, 10) == 0);
    assert(drmHashLookup(table, 10, &value) == 1);
    assert(drmHashDestroy(table) == 0);

    void *list = drmSLCreate();
    assert(list);
    for (unsigned i = 0; i < 3; ++i) assert(drmSLInsert(list, keys[i], &payload[i]) == 0);
    assert(drmSLLookup(list, 20, &value) == 0 && value);
    /* Native Lookup returns an internal entry; payloads are checked by ordered iteration. */
    count = 0;
    unsigned long previous = 0;
    for (int found = drmSLFirst(list, &key, &value); found; found = drmSLNext(list, &key, &value)) {
        assert(found == 1 && key > previous);
        unsigned i;
        for (i = 0; i < 3 && keys[i] != key; ++i) {}
        assert(i < 3 && value == &payload[i]);
        previous = key;
        ++count;
    }
    assert(count == 3);
    unsigned long before, after;
    void *before_value, *after_value;
    assert(drmSLLookupNeighbors(list, 15, &before, &before_value, &after, &after_value) == 2);
    assert(before == 10 && before_value == &payload[1]);
    assert(after == 20 && after_value == &payload[2]);
    assert(drmSLDelete(list, 20) == 0);
    assert(drmSLLookup(list, 20, &value) != 0);
    assert(drmSLDestroy(list) == 0);
    char *format = drmGetFormatName(DRM_FORMAT_XRGB8888);
    assert(format && strcmp(format, "XR24") == 0);
    free(format);
    format = drmGetFormatName(DRM_FORMAT_INVALID);
    assert(format && strcmp(format, "INVALID") == 0);
    free(format);
    assert(drmGetVersion(-1) == NULL);
    puts("DRM: owned hash/skip-list data, iteration/neighbors, allocated format names and invalid-FD contract passed");
}
