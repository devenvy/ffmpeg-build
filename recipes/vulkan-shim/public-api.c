#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>
#include <vulkan/vulkan.h>

static DWORD WINAPI query_version(LPVOID unused) {
    (void)unused;
    uint32_t version = 0;
    return vkEnumerateInstanceVersion(&version) == VK_SUCCESS &&
        version == VK_MAKE_API_VERSION(0, 1, 2, 345) ? 0 : 1;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    const int failed_load = !strcmp(argv[1], "failed-load");
    // The DLL is already imported at process startup; its initialization must
    // not load the Vulkan runtime while the Windows loader lock is held.
    assert(GetModuleHandleA("ffb-vulkan-shim.dll"));
    assert(!GetModuleHandleA("vulkan-1.dll"));
    if (failed_load) {
        SetLastError(0);
        assert(!LoadLibraryExA("vulkan-1.dll", NULL, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS));
        assert(GetLastError() == ERROR_DLL_INIT_FAILED);
        uint32_t version = 0;
        assert(vkEnumerateInstanceVersion(&version) == VK_ERROR_INITIALIZATION_FAILED);
        assert(!GetModuleHandleA("vulkan-1.dll"));
    } else {
        HANDLE threads[16];
        for (unsigned i = 0; i < 16; i++) {
            threads[i] = CreateThread(NULL, 0, query_version, NULL, 0, NULL);
            assert(threads[i]);
        }
        assert(WaitForMultipleObjects(16, threads, TRUE, 30000) == WAIT_OBJECT_0);
        for (unsigned i = 0; i < 16; i++) {
            DWORD result = 1;
            assert(GetExitCodeThread(threads[i], &result) && result == 0);
            assert(CloseHandle(threads[i]));
        }
        HMODULE driver = GetModuleHandleA("vulkan-1.dll");
        assert(driver);
        char driver_path[MAX_PATH], program_path[MAX_PATH];
        assert(GetModuleFileNameA(driver, driver_path, MAX_PATH));
        assert(GetModuleFileNameA(NULL, program_path, MAX_PATH));
        *strrchr(driver_path, '\\') = 0;
        *strrchr(program_path, '\\') = 0;
        assert(!_stricmp(driver_path, program_path));
        VkInstanceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO };
        VkInstance instance = VK_NULL_HANDLE;
        assert(vkCreateInstance(&info, NULL, &instance) == VK_SUCCESS);
        assert(instance == (VkInstance)(uintptr_t)0x12340000);
        assert(vkGetInstanceProcAddr(instance, "ffb_marker"));
        assert(!vkGetInstanceProcAddr(instance, "ffb_unknown"));
        vkDestroyInstance(instance, NULL);
        int (*counts)(void) = (int (*)(void))GetProcAddress(driver, "ffb_fixture_counts");
        assert(counts && counts());
    }
    // Unexported functions in the owned partial fixture exercise the native
    // result, pointer and void fallbacks without any installed GPU requirement.
    uint32_t physical_count = 0;
    assert(vkEnumeratePhysicalDevices(VK_NULL_HANDLE, &physical_count, NULL) ==
           VK_ERROR_INITIALIZATION_FAILED);
    assert(!vkGetDeviceProcAddr(VK_NULL_HANDLE, "missing"));
    vkDestroyDevice(VK_NULL_HANDLE, NULL);
    puts("Vulkan shim: native API forwarding, synchronized lazy initialization and driver-optional fallbacks passed");
    return 0;
}
