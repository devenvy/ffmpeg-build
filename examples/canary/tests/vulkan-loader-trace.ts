import assert from 'node:assert/strict';
import { dirname } from 'node:path';

export function assertVulkanLoaderTrace(
  debug: string,
  { shared, required, runtime }: { shared: boolean; required: boolean; runtime: string },
): void {
  const initialized = [...debug.matchAll(/calling init: ([^\r\n]*\/libvulkan\.so[^\r\n]*)/g)].map(
    (match) => {
      const path = match[1];
      assert.ok(path);
      return path.trim();
    },
  );
  if (!shared) {
    assert.deepEqual(initialized, [], 'A static loader build initialized a dynamic loader');
    return;
  }
  if (required) {
    assert.ok(initialized.length > 0, 'Vulkan did not initialize the bundled loader');
  }
  for (const path of initialized) {
    assert.equal(dirname(path), runtime, 'Vulkan loader must come from the runtime archive');
  }
}
