#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <vulkan/vulkan.h>
#include <libplacebo/vulkan.h>
#include <libplacebo/gpu.h>

int main(void) {
  VkApplicationInfo application = {
    .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
    .pApplicationName = "Owned Vulkan import lifecycle",
    .apiVersion = VK_API_VERSION_1_2,
  };
  VkInstanceCreateInfo info = {
    .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
    .pApplicationInfo = &application,
  };
  VkInstance instance;
  assert(vkCreateInstance(&info, NULL, &instance) == VK_SUCCESS);
  uint32_t count = 0;
  assert(vkEnumeratePhysicalDevices(instance, &count, NULL) == VK_SUCCESS && count > 0);
  VkPhysicalDevice *physical_devices = calloc(count, sizeof(*physical_devices));
  assert(physical_devices);
  assert(vkEnumeratePhysicalDevices(instance, &count, physical_devices) == VK_SUCCESS);
  VkPhysicalDevice physical = physical_devices[0];
  free(physical_devices);
  VkPhysicalDeviceVulkan12Features features12 = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES,
  };
  VkPhysicalDeviceVulkan11Features features11 = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES,
    .pNext = &features12,
  };
  VkPhysicalDeviceFeatures2 features = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2,
    .pNext = &features11,
  };
  vkGetPhysicalDeviceFeatures2(physical, &features);
  assert(features12.hostQueryReset && features12.timelineSemaphore);
  uint32_t families = 0;
  vkGetPhysicalDeviceQueueFamilyProperties(physical, &families, NULL);
  assert(families > 0);
  VkQueueFamilyProperties *properties = calloc(families, sizeof(*properties));
  assert(properties);
  vkGetPhysicalDeviceQueueFamilyProperties(physical, &families, properties);
  uint32_t family = 0;
  VkQueueFlags required = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT;
  while (family < families && ((properties[family].queueFlags & required) != required || !properties[family].queueCount)) {
    family++;
  }
  assert(family < families);
  free(properties);
  const float priority = 1.0f;
  VkDeviceQueueCreateInfo queue_info = {
    .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
    .queueFamilyIndex = family, .queueCount = 1, .pQueuePriorities = &priority,
  };
  VkDeviceCreateInfo device_info = {
    .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
    .pNext = &pl_vulkan_required_features,
    .queueCreateInfoCount = 1, .pQueueCreateInfos = &queue_info,
  };
  VkDevice device;
  assert(vkCreateDevice(physical, &device_info, NULL, &device) == VK_SUCCESS);
  pl_log log = pl_log_create(PL_API_VER, NULL);
  assert(log);
  struct pl_vulkan_import_params params = {
    .instance = instance, .get_proc_addr = vkGetInstanceProcAddr,
    .phys_device = physical, .device = device,
    .queue_graphics = { .index = family, .count = 1 },
    .queue_compute = { .index = family, .count = 1 },
    .queue_transfer = { .index = family, .count = 1 },
    .features = &pl_vulkan_required_features,
  };
  pl_vulkan imported = pl_vulkan_import(log, &params);
  assert(imported && imported->instance == instance && imported->device == device);
  assert(imported->get_proc_addr == vkGetInstanceProcAddr);
  pl_gpu_finish(imported->gpu);
  pl_vulkan_destroy(&imported);
  assert(!imported);
  VkCommandPoolCreateInfo pool_info = {
    .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = family,
  };
  VkCommandPool pool;
  assert(vkCreateCommandPool(device, &pool_info, NULL, &pool) == VK_SUCCESS);
  VkCommandBufferAllocateInfo allocation = {
    .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
    .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1,
  };
  VkCommandBuffer command;
  assert(vkAllocateCommandBuffers(device, &allocation, &command) == VK_SUCCESS);
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  assert(vkBeginCommandBuffer(command, &begin) == VK_SUCCESS);
  assert(vkEndCommandBuffer(command) == VK_SUCCESS);
  VkFenceCreateInfo fence_info = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  VkFence fence;
  assert(vkCreateFence(device, &fence_info, NULL, &fence) == VK_SUCCESS);
  VkQueue queue;
  vkGetDeviceQueue(device, family, 0, &queue);
  VkSubmitInfo submit = {
    .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &command,
  };
  assert(vkQueueSubmit(queue, 1, &submit, fence) == VK_SUCCESS);
  assert(vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_C(5000000000)) == VK_SUCCESS);
  vkDestroyFence(device, fence, NULL);
  vkDestroyCommandPool(device, pool, NULL);
  vkDestroyDevice(device, NULL);
  vkDestroyInstance(instance, NULL);
  pl_log_destroy(&log);
  puts("Vulkan: imported wrapper released; caller-owned device still submits and completes work");
  return 0;
}
