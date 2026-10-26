interface Definition {
  name: string;
  type: string;
}

const protobuf = /^_Z(?:NK?|T[VIS]N)6google8protobuf/;
// Native Torch's allocator specializations name its own ONNX types, not another provider's messages.
const torchArena =
  /^_ZN6google8protobuf5Arena18CreateMaybeMessageIN10onnx_torch\d+[A-Za-z_][A-Za-z0-9_]*EJEEEPT_PS1_DpOT0_$/;
const torchSwap =
  '_ZN6google8protobuf8internal20RepeatedPtrFieldBase12SwapFallbackINS0_16RepeatedPtrFieldIN10onnx_torch9NodeProtoEE11TypeHandlerEEEvPS2_';
// These three native 3.13 helpers only swap raw bytes; the newer TF/ORT runtimes use different names.
const byteSwaps = new Set([
  '_ZN6google8protobuf8internal8byteswapILi1EEEvPv',
  '_ZN6google8protobuf8internal8byteswapILi4EEEvPv',
  '_ZN6google8protobuf8internal8byteswapILi8EEEvPv',
]);

function reviewedTorchFunction({ name, type }: Definition): boolean {
  return (
    ['T', 'W'].includes(type) &&
    (torchArena.test(name) || name === torchSwap || byteSwaps.has(name))
  );
}

export function unexpectedProtobufExports(
  backend: string,
  owner: string,
  definitions: Definition[],
): Definition[] {
  const torchOwner = backend === 'torch' && /^libtorch_cpu\.so(?:\.\d+)+$/.test(owner);
  return definitions.filter(
    (definition) =>
      protobuf.test(definition.name) && !(torchOwner && reviewedTorchFunction(definition)),
  );
}
