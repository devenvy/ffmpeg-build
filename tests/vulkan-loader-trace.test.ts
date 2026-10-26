import { describe, expect, it } from 'vitest';

import { assertVulkanLoaderTrace } from '../examples/canary/tests/vulkan-loader-trace.ts';

const bundled = '  123:\tcalling init: /runtime/libvulkan.so.1\n';
const system = '  123:\tcalling init: /usr/lib/libvulkan.so.1\n';
const cpu = '  123:\tcalling init: /runtime/libwhisper.so.1\n';
const driver = '  123:\tcalling init: /usr/lib/libvulkan_lvp.so\n';

describe('Vulkan loader ownership in native runtime traces', () => {
  it('allows CPU inference without initializing an available optional loader', () => {
    expect(() => assertVulkanLoaderTrace(cpu, { shared: true, required: false })).not.toThrow();
  });

  it('requires the bundled loader when the test exercises Vulkan', () => {
    expect(() => assertVulkanLoaderTrace(cpu, { shared: true, required: true })).toThrow(
      /did not match/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { shared: true, required: true })).not.toThrow();
  });

  it('checks ownership if CPU inference happens to initialize a loader', () => {
    expect(() => assertVulkanLoaderTrace(system, { shared: true, required: false })).toThrow(
      /did not match/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { shared: true, required: false })).not.toThrow();
  });

  it('rejects a system loader for a GPU test that ships its own loader', () => {
    expect(() => assertVulkanLoaderTrace(system, { shared: true, required: true })).toThrow(
      /did not match/,
    );
  });

  it('rejects a dynamic loader in a static-loader build', () => {
    expect(() => assertVulkanLoaderTrace(system, { shared: false, required: true })).toThrow(
      /expected to not match/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { shared: false, required: false })).toThrow(
      /expected to not match/,
    );
  });

  it('allows the native ICD driver while the loader is static', () => {
    expect(() => assertVulkanLoaderTrace(driver, { shared: false, required: true })).not.toThrow();
  });
});
