import assert from 'node:assert/strict';

export function assertVulkanLoaderTrace(
  debug: string,
  { shared, required }: { shared: boolean; required: boolean },
): void {
  const initialized = /calling init: .*\/libvulkan\.so/.test(debug);
  if (shared && (required || initialized)) {
    assert.match(debug, /calling init: \/runtime\/libvulkan\.so/);
  } else if (!shared) {
    assert.doesNotMatch(debug, /calling init: .*\/libvulkan\.so/);
  }
}
