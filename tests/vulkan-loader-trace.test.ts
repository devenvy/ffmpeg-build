import { describe, expect, it } from 'vitest';

import { assertVulkanLoaderTrace } from '../examples/canary/tests/vulkan-loader-trace.ts';

const bundled = '  123:\tcalling init: /runtime/libvulkan.so.1\n';
const system = '  123:\tcalling init: /usr/lib/libvulkan.so.1\n';
const cpu = '  123:\tcalling init: /runtime/libwhisper.so.1\n';
const driver = '  123:\tcalling init: /usr/lib/libvulkan_lvp.so\n';
const shared = { shared: true, runtime: '/runtime' };
const staticLoader = { shared: false, runtime: '/runtime' };

describe('Vulkan loader ownership in native runtime traces', () => {
  it('allows CPU inference without initializing an available optional loader', () => {
    expect(() => assertVulkanLoaderTrace(cpu, { ...shared, required: false })).not.toThrow();
  });

  it('requires the bundled loader when the test exercises Vulkan', () => {
    expect(() => assertVulkanLoaderTrace(cpu, { ...shared, required: true })).toThrow(
      /did not initialize/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { ...shared, required: true })).not.toThrow();
  });

  it('checks ownership if CPU inference happens to initialize a loader', () => {
    expect(() => assertVulkanLoaderTrace(system, { ...shared, required: false })).toThrow(
      /must come from the runtime archive/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { ...shared, required: false })).not.toThrow();
  });

  it('rejects a system loader for a GPU test that ships its own loader', () => {
    expect(() => assertVulkanLoaderTrace(system, { ...shared, required: true })).toThrow(
      /must come from the runtime archive/,
    );
  });

  it('rejects a dynamic loader in a static-loader build', () => {
    expect(() => assertVulkanLoaderTrace(system, { ...staticLoader, required: true })).toThrow(
      /static loader build initialized a dynamic loader/,
    );
    expect(() => assertVulkanLoaderTrace(bundled, { ...staticLoader, required: false })).toThrow(
      /static loader build initialized a dynamic loader/,
    );
  });

  it('allows the native ICD driver while the loader is static', () => {
    expect(() =>
      assertVulkanLoaderTrace(driver, { ...staticLoader, required: true }),
    ).not.toThrow();
  });

  it('checks the actual extracted runtime directory, including spaces and regexp characters', () => {
    const runtime = '/tmp/ffmpeg-build-test [owned]';
    expect(() =>
      assertVulkanLoaderTrace(`  123:\tcalling init: ${runtime}/libvulkan.so.1\n`, {
        shared: true,
        required: true,
        runtime,
      }),
    ).not.toThrow();
  });

  it('rejects a different directory or an additional system loader', () => {
    for (const trace of [bundled.replace('/runtime/', '/runtime-other/'), bundled + system]) {
      expect(() => assertVulkanLoaderTrace(trace, { ...shared, required: true })).toThrow(
        /must come from the runtime archive/,
      );
    }
  });
});
