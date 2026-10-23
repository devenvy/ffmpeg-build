#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_vulkan.h>

int main(int argc, char **argv) {
    assert(argc == 2);
    const int shared = !strcmp(argv[1], "shared");
    for (int attempt = 0; attempt < 3; attempt++) {
        AVBufferRef *reference = NULL;
        assert(av_hwdevice_ctx_create(&reference, AV_HWDEVICE_TYPE_VULKAN, NULL, NULL, 0) == 0);
        AVHWDeviceContext *context = (AVHWDeviceContext *)reference->data;
        AVVulkanDeviceContext *vulkan = context->hwctx;
        assert(vulkan->get_proc_addr && vulkan->inst && vulkan->phys_dev && vulkan->act_dev);
        Dl_info owner;
        assert(dladdr((void *)vulkan->get_proc_addr, &owner) && owner.dli_fname);
        assert(strstr(owner.dli_fname, shared ? "libvulkan" : "libavutil"));
        PFN_vkGetPhysicalDeviceProperties properties = (PFN_vkGetPhysicalDeviceProperties)
            vulkan->get_proc_addr(vulkan->inst, "vkGetPhysicalDeviceProperties");
        assert(properties);
        VkPhysicalDeviceProperties device;
        properties(vulkan->phys_dev, &device);
        PFN_vkGetDeviceProcAddr device_proc = (PFN_vkGetDeviceProcAddr)
            vulkan->get_proc_addr(vulkan->inst, "vkGetDeviceProcAddr");
        assert(device_proc);
        PFN_vkDeviceWaitIdle idle = (PFN_vkDeviceWaitIdle)
            device_proc(vulkan->act_dev, "vkDeviceWaitIdle");
        assert(idle && idle(vulkan->act_dev) == VK_SUCCESS);
        printf("FFmpeg Vulkan callback owner %s; GPU %s\n", owner.dli_fname, device.deviceName);
        av_buffer_unref(&reference);
        assert(!reference);
    }
    return 0;
}
