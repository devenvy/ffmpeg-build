#include <windows.h>
#include <stdint.h>
#include <string.h>
#include <vulkan/vulkan.h>

static LONG created;
static LONG destroyed;

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reserved;
#ifdef FFB_FAIL_LOAD
    return reason != DLL_PROCESS_ATTACH;
#else
    (void)reason;
    return TRUE;
#endif
}

__declspec(dllexport) VkResult VKAPI_CALL vkEnumerateInstanceVersion(uint32_t *version) {
    *version = VK_MAKE_API_VERSION(0, 1, 2, 345);
    return VK_SUCCESS;
}

__declspec(dllexport) VkResult VKAPI_CALL vkCreateInstance(
    const VkInstanceCreateInfo *info, const VkAllocationCallbacks *allocator, VkInstance *instance) {
    if (!info || info->sType != VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO || allocator)
        return VK_ERROR_UNKNOWN;
    *instance = (VkInstance)(uintptr_t)0x12340000;
    InterlockedIncrement(&created);
    return VK_SUCCESS;
}

__declspec(dllexport) void VKAPI_CALL vkDestroyInstance(
    VkInstance instance, const VkAllocationCallbacks *allocator) {
    if (instance == (VkInstance)(uintptr_t)0x12340000 && !allocator)
        InterlockedIncrement(&destroyed);
}

static void VKAPI_CALL marker(void) {}

__declspec(dllexport) PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(
    VkInstance instance, const char *name) {
    return instance == (VkInstance)(uintptr_t)0x12340000 && !strcmp(name, "ffb_marker")
        ? marker : NULL;
}

__declspec(dllexport) int ffb_fixture_counts(void) {
    return created == 1 && destroyed == 1;
}
