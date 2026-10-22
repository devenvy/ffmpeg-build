#include <ffi.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "libffi SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static double arithmetic(int number, const char* text, double scale) {
  return number + strlen(text) * scale;
}
static void ffi_callback(ffi_cif* cif, void* result, void** arguments, void* opaque) {
  (void)cif;
  *(int*)result = *(int*)arguments[0] + *(int*)arguments[1] + *(int*)opaque;
}
static int ffi_sdk(void) {
  ffi_cif cif;
  ffi_type* types[] = {&ffi_type_sint32, &ffi_type_pointer, &ffi_type_double};
  int number = 7;
  const char* text = "FFB";
  double scale = .5;
  void* values[] = {&number, &text, &scale};
  CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_double, types) == FFI_OK);
  double returned = 0;
  ffi_call(&cif, FFI_FN(arithmetic), &returned, values);
  CHECK(fabs(returned - 8.5) < .000001);
  ffi_type* closure_types[] = {&ffi_type_sint32, &ffi_type_sint32};
  CHECK(ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint32, closure_types) == FFI_OK);
  void* code = NULL;
  ffi_closure* closure = ffi_closure_alloc(sizeof(*closure), &code);
  CHECK(closure && code);
  int bias = 5;
  CHECK(ffi_prep_closure_loc(closure, &cif, ffi_callback, &bias, code) == FFI_OK);
  int (*callback)(int,int) = (int (*)(int,int))code;
  CHECK(callback(3,4) == 12);
  ffi_closure_free(closure);
  puts("libffi: mixed scalar call, exported ffi_type data and executable closure passed");
  return 0;
}


int main(void) { return ffi_sdk(); }
