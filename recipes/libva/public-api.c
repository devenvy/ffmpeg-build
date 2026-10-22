#include <va/va.h>
#include <va/va_drm.h>
#include <va/va_str.h>
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    assert(strcmp(vaErrorStr(VA_STATUS_SUCCESS), "success (no error)") == 0);
    assert(strcmp(vaProfileStr(VAProfileH264High), "VAProfileH264High") == 0);
    assert(strcmp(vaEntrypointStr(VAEntrypointVLD), "VAEntrypointVLD") == 0);
    assert(vaGetDisplayDRM(-1) == NULL);
    int descriptor = open("/dev/null", O_RDWR);
    assert(descriptor >= 0);
    assert(vaGetDisplayDRM(descriptor) == NULL);
    assert(close(descriptor) == 0);
    assert(!vaDisplayIsValid(NULL));
    assert(vaQueryVendorString(NULL) == NULL);
    assert(vaMaxNumProfiles(NULL) == 0);
    int major = -1, minor = -1;
    assert(vaInitialize(NULL, &major, &minor) == VA_STATUS_ERROR_INVALID_DISPLAY);
    assert(major == -1 && minor == -1);
    assert(vaTerminate(NULL) == VA_STATUS_ERROR_INVALID_DISPLAY);
    puts("VA: native utilities, caller-owned FD cleanup and invalid-display contracts passed; no GPU initialization claim");
}
