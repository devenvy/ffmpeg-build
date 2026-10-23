#include <tensorflow/c/c_api.h>
#include <tensorflow/c/c_api_experimental.h>
#include <tensorflow/c/eager/c_api.h>
#include <tensorflow/c/eager/c_api_experimental.h>

// Native experimental headers include C++ declarations. Validate their installed
// include closure with its matching language, separately from the C runtime SDK.
static_assert(TFE_CUSTOM_DEVICE_VERSION > 0, "native experimental device ABI");
