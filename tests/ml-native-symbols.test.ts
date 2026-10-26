import { describe, expect, it } from 'vitest';

import { unexpectedProtobufExports } from '../examples/canary/tests/ml-native-symbols.ts';

const owner = 'libtorch_cpu.so.2.7';
const arena =
  '_ZN6google8protobuf5Arena18CreateMaybeMessageIN10onnx_torch9NodeProtoEJEEEPT_PS1_DpOT0_';
const swap =
  '_ZN6google8protobuf8internal20RepeatedPtrFieldBase12SwapFallbackINS0_16RepeatedPtrFieldIN10onnx_torch9NodeProtoEE11TypeHandlerEEEvPS2_';
const reviewed = [
  { name: arena, type: 'T' },
  { name: swap, type: 'W' },
  ...[1, 4, 8].map((width) => ({
    name: `_ZN6google8protobuf8internal8byteswapILi${width}EEEvPv`,
    type: 'T',
  })),
];

describe('native ML Protobuf export ownership', () => {
  it('accepts the reviewed Torch type specializations and three stateless native helpers', () => {
    expect(unexpectedProtobufExports('torch', owner, reviewed)).toEqual([]);
  });

  it('still rejects generic runtime providers, including weak functions and exported RTTI', () => {
    const core = [
      { name: '_ZNK6google8protobuf11MessageLite13ByteSizeLongEv', type: 'W' },
      { name: '_ZN6google8protobuf14DescriptorPoolC1Ev', type: 'T' },
      { name: '_ZTVN6google8protobuf7MessageE', type: 'V' },
    ];
    expect(unexpectedProtobufExports('torch', owner, [...reviewed, ...core])).toEqual(core);
  });

  it('does not permit Torch-owned definitions in another backend or another Torch owner', () => {
    expect(unexpectedProtobufExports('tensorflow', 'libtensorflow.so.2', reviewed)).toEqual(
      reviewed,
    );
    expect(unexpectedProtobufExports('torch', 'libc10.so.2.7', reviewed)).toEqual(reviewed);
  });

  it('does not accept a different ONNX namespace or additional byte-swap specializations', () => {
    const different = [
      { name: arena.replace('10onnx_torch', '4onnx'), type: 'T' },
      { name: '_ZN6google8protobuf8internal8byteswapILi2EEEvPv', type: 'T' },
    ];
    expect(unexpectedProtobufExports('torch', owner, different)).toEqual(different);
  });

  it('does not mistake an exported data definition for a reviewed native function', () => {
    const data = [{ name: arena, type: 'V' }];
    expect(unexpectedProtobufExports('torch', owner, data)).toEqual(data);
  });

  it('leaves unrelated public API names outside the private Protobuf audit', () => {
    expect(unexpectedProtobufExports('torch', owner, [{ name: 'TF_Version', type: 'T' }])).toEqual(
      [],
    );
  });
});
