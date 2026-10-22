#include "tensorflow/c/c_api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(TF_Status *status) {
    if (TF_GetCode(status) != TF_OK) {
        fprintf(stderr, "TensorFlow: %s\n", TF_Message(status));
        exit(1);
    }
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    TF_Status *status = TF_NewStatus();
    TF_Graph *graph = TF_NewGraph();
    int64_t dims[] = {1, 2, 2, 3};
    TF_OperationDescription *desc = TF_NewOperation(graph, "Placeholder", "x");
    TF_SetAttrType(desc, "dtype", TF_FLOAT);
    TF_SetAttrShape(desc, "shape", dims, 4);
    TF_Operation *input_op = TF_FinishOperation(desc, status);
    check(status);
    desc = TF_NewOperation(graph, "Relu", "y");
    TF_Output input = {input_op, 0};
    TF_AddInput(desc, input);
    TF_Operation *output_op = TF_FinishOperation(desc, status);
    check(status);
    TF_Output output = {output_op, 0};
    TF_Buffer *buffer = TF_NewBuffer();
    TF_GraphToGraphDef(graph, buffer, status);
    check(status);
    FILE *model = fopen(argv[1], "wb");
    if (!model || fwrite(buffer->data, 1, buffer->length, model) != buffer->length) return 1;
    fclose(model);
    TF_DeleteBuffer(buffer);
    TF_SessionOptions *options = TF_NewSessionOptions();
    TF_Session *session = TF_NewSession(graph, options, status);
    check(status);
    TF_Tensor *tensor = TF_AllocateTensor(TF_FLOAT, dims, 4, 12 * sizeof(float));
    float values[] = {-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5};
    memcpy(TF_TensorData(tensor), values, sizeof(values));
    TF_Tensor *result = NULL;
    TF_SessionRun(session, NULL, &input, &tensor, 1, &output, &result, 1, NULL, 0, NULL, status);
    check(status);
    for (int i = 0; i < 12; i++) {
        float expected = values[i] < 0 ? 0 : values[i];
        if (((float *)TF_TensorData(result))[i] != expected) return 1;
    }
    TF_DeleteTensor(result);
    TF_DeleteTensor(tensor);
    TF_CloseSession(session, status);
    check(status);
    TF_DeleteSession(session, status);
    check(status);
    TF_DeleteSessionOptions(options);
    TF_DeleteGraph(graph);
    TF_DeleteStatus(status);
    puts("Static TensorFlow C API CPU ReLU inference passed");
    return 0;
}
