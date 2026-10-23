#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

int main(void) {
    uint32_t extension_count = 0;
    assert(vkEnumerateInstanceExtensionProperties(NULL, &extension_count, NULL) == VK_SUCCESS);
    VkExtensionProperties *extensions = calloc(extension_count, sizeof(*extensions));
    assert(extensions);
    assert(vkEnumerateInstanceExtensionProperties(NULL, &extension_count, extensions) == VK_SUCCESS);
    const char *portability = VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME;
    int supports_portability = 0;
    for (uint32_t i = 0; i < extension_count; i++)
        supports_portability |= !strcmp(extensions[i].extensionName, portability);
    free(extensions);
    VkApplicationInfo application = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "ffmpeg-build-owned-moltenvk-sdk",
        .apiVersion = VK_API_VERSION_1_3,
    };
    VkInstanceCreateInfo instance_info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &application,
        .flags = supports_portability ? VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR : 0,
        .enabledExtensionCount = supports_portability ? 1 : 0,
        .ppEnabledExtensionNames = supports_portability ? &portability : NULL,
    };
    VkInstance instance = VK_NULL_HANDLE;
    assert(vkCreateInstance(&instance_info, NULL, &instance) == VK_SUCCESS);
    uint32_t physical_count = 0;
    assert(vkEnumeratePhysicalDevices(instance, &physical_count, NULL) == VK_SUCCESS);
    assert(physical_count > 0);
    VkPhysicalDevice *physical_devices = calloc(physical_count, sizeof(*physical_devices));
    assert(physical_devices);
    assert(vkEnumeratePhysicalDevices(instance, &physical_count, physical_devices) == VK_SUCCESS);
    VkPhysicalDevice physical = physical_devices[0];
    free(physical_devices);
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(physical, &properties);
    uint32_t queue_count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &queue_count, NULL);
    VkQueueFamilyProperties *families = calloc(queue_count, sizeof(*families));
    assert(families);
    vkGetPhysicalDeviceQueueFamilyProperties(physical, &queue_count, families);
    uint32_t family = UINT32_MAX;
    for (uint32_t i = 0; i < queue_count; i++)
        if (families[i].queueCount && (families[i].queueFlags & VK_QUEUE_COMPUTE_BIT)) {
            family = i;
            break;
        }
    free(families);
    assert(family != UINT32_MAX);
    const float priority = 1;
    VkDeviceQueueCreateInfo queue_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = family, .queueCount = 1, .pQueuePriorities = &priority,
    };
    // MoltenVK exposes this mandatory device extension for portability devices.
    uint32_t device_extension_count = 0;
    assert(vkEnumerateDeviceExtensionProperties(physical, NULL, &device_extension_count, NULL) == VK_SUCCESS);
    VkExtensionProperties *device_extensions = calloc(device_extension_count, sizeof(*device_extensions));
    assert(device_extensions);
    assert(vkEnumerateDeviceExtensionProperties(physical, NULL, &device_extension_count, device_extensions) == VK_SUCCESS);
    const char *subset = "VK_KHR_portability_subset";
    int needs_subset = 0;
    for (uint32_t i = 0; i < device_extension_count; i++)
        needs_subset |= !strcmp(device_extensions[i].extensionName, subset);
    free(device_extensions);
    VkDeviceCreateInfo device_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount = 1, .pQueueCreateInfos = &queue_info,
        .enabledExtensionCount = needs_subset ? 1 : 0,
        .ppEnabledExtensionNames = needs_subset ? &subset : NULL,
    };
    VkDevice device = VK_NULL_HANDLE;
    assert(vkCreateDevice(physical, &device_info, NULL, &device) == VK_SUCCESS);
    VkQueue queue = VK_NULL_HANDLE;
    vkGetDeviceQueue(device, family, 0, &queue);
    assert(queue);
    VkBufferCreateInfo buffer_info = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = 256, .usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    VkBuffer buffer = VK_NULL_HANDLE;
    assert(vkCreateBuffer(device, &buffer_info, NULL, &buffer) == VK_SUCCESS);
    VkMemoryRequirements requirements;
    vkGetBufferMemoryRequirements(device, buffer, &requirements);
    VkPhysicalDeviceMemoryProperties memory_properties;
    vkGetPhysicalDeviceMemoryProperties(physical, &memory_properties);
    uint32_t type = UINT32_MAX;
    const VkMemoryPropertyFlags wanted = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    for (uint32_t i = 0; i < memory_properties.memoryTypeCount; i++)
        if ((requirements.memoryTypeBits & (1U << i)) &&
            (memory_properties.memoryTypes[i].propertyFlags & wanted) == wanted) {
            type = i;
            break;
        }
    assert(type != UINT32_MAX);
    VkMemoryAllocateInfo allocation = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = requirements.size, .memoryTypeIndex = type,
    };
    VkDeviceMemory memory = VK_NULL_HANDLE;
    assert(vkAllocateMemory(device, &allocation, NULL, &memory) == VK_SUCCESS);
    assert(vkBindBufferMemory(device, buffer, memory, 0) == VK_SUCCESS);
    VkCommandPoolCreateInfo pool_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = family,
    };
    VkCommandPool pool = VK_NULL_HANDLE;
    assert(vkCreateCommandPool(device, &pool_info, NULL, &pool) == VK_SUCCESS);
    VkCommandBufferAllocateInfo command_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1,
    };
    VkCommandBuffer commands = VK_NULL_HANDLE;
    assert(vkAllocateCommandBuffers(device, &command_info, &commands) == VK_SUCCESS);
    VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    assert(vkBeginCommandBuffer(commands, &begin) == VK_SUCCESS);
    vkCmdFillBuffer(commands, buffer, 0, buffer_info.size, 0x11223344);
    VkMemoryBarrier host_read = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT, .dstAccessMask = VK_ACCESS_HOST_READ_BIT,
    };
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_HOST_BIT,
                         0, 1, &host_read, 0, NULL, 0, NULL);
    assert(vkEndCommandBuffer(commands) == VK_SUCCESS);
    VkFenceCreateInfo fence_info = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    VkFence fence = VK_NULL_HANDLE;
    assert(vkCreateFence(device, &fence_info, NULL, &fence) == VK_SUCCESS);
    VkSubmitInfo submit = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &commands,
    };
    assert(vkQueueSubmit(queue, 1, &submit, fence) == VK_SUCCESS);
    assert(vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_C(10000000000)) == VK_SUCCESS);
    uint32_t *mapped = NULL;
    assert(vkMapMemory(device, memory, 0, buffer_info.size, 0, (void **)&mapped) == VK_SUCCESS);
    for (size_t i = 0; i < buffer_info.size / sizeof(*mapped); i++)
        assert(mapped[i] == 0x11223344);
    vkUnmapMemory(device, memory);
    vkDestroyFence(device, fence, NULL);
    vkFreeCommandBuffers(device, pool, 1, &commands);
    vkDestroyCommandPool(device, pool, NULL);
    vkDestroyBuffer(device, buffer, NULL);
    vkFreeMemory(device, memory, NULL);
    assert(vkDeviceWaitIdle(device) == VK_SUCCESS);
    vkDestroyDevice(device, NULL);
    vkDestroyInstance(instance, NULL);
    printf("Native MoltenVK SDK: %s; instance/device/queue, GPU-authored bytes and complete resource cleanup passed\n", properties.deviceName);
    return 0;
}
