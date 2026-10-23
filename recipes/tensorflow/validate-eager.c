#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tensorflow/c/c_api.h>
#include <tensorflow/c/eager/c_api.h>

static int released;
static void release(void *data, size_t bytes, void *argument) {
    assert(argument == &released && bytes == 4 * sizeof(float));
    ++released;
    free(data);
}
static void check(TF_Status *status) {
    if (TF_GetCode(status) != TF_OK) {
        fprintf(stderr, "TensorFlow eager: %s\n", TF_Message(status));
        abort();
    }
}
int main(void) {
    TF_Status *status = TF_NewStatus();
    TFE_ContextOptions *options = TFE_NewContextOptions();
    TFE_Context *context = TFE_NewContext(options, status);
    check(status);
    TFE_DeleteContextOptions(options);
    const float values[] = {-3.0f, 2.0f, -1.0f, 4.0f};
    float *storage = malloc(sizeof(values));
    assert(storage);
    memcpy(storage, values, sizeof(values));
    const int64_t dimensions[] = {4};
    TF_Tensor *tensor = TF_NewTensor(TF_FLOAT, dimensions, 1, storage, sizeof(values), release, &released);
    assert(tensor);
    TFE_TensorHandle *input = TFE_NewTensorHandle(tensor, status);
    check(status);
    TF_DeleteTensor(tensor);
    assert(TFE_TensorHandleNumDims(input, status) == 1);
    check(status);
    TFE_Op *operation = TFE_NewOp(context, "Relu", status);
    check(status);
    TFE_OpSetAttrType(operation, "T", TF_FLOAT);
    TFE_OpAddInput(operation, input, status);
    check(status);
    TFE_TensorHandle *output = NULL;
    int count = 1;
    TFE_Execute(operation, &output, &count, status);
    check(status);
    assert(count == 1 && output);
    assert(strstr(TFE_TensorHandleDeviceName(output, status), "CPU"));
    check(status);
    TF_Tensor *resolved = TFE_TensorHandleResolve(output, status);
    check(status);
    TFE_DeleteTensorHandle(output);
    TFE_DeleteOp(operation);
    TFE_DeleteTensorHandle(input);
    TFE_Op *invalid = TFE_NewOp(context, "ffbOwnedInvalidOperation", status);
    assert(TF_GetCode(status) != TF_OK);
    if (invalid) TFE_DeleteOp(invalid);
    TFE_DeleteContext(context);
    assert(TF_TensorType(resolved) == TF_FLOAT && TF_NumDims(resolved) == 1);
    assert(TF_Dim(resolved, 0) == 4 && TF_TensorByteSize(resolved) == sizeof(values));
    const float *actual = TF_TensorData(resolved);
    for (size_t index = 0; index < 4; ++index) {
        assert(actual[index] == (values[index] < 0 ? 0 : values[index]));
    }
    TF_DeleteTensor(resolved);
    assert(released == 1);
    TF_DeleteStatus(status);
    puts("TensorFlow eager SDK: CPU ReLU, retained output, caller tensor deleter and invalid operation status passed");
    return 0;
}
