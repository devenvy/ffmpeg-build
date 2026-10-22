#define PCRE2_CODE_UNIT_WIDTH 8
#include <pcre2.h>
#include <pcre2posix.h>
#include <ffi.h>
#include <glib.h>
#include <glib-object.h>
#include <gio/gio.h>
#include <gmodule.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "GLib stack SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)

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

static int regex_sdk(void) {
  int error = 0;
  PCRE2_SIZE offset = 0;
  pcre2_code* compiled = pcre2_compile((PCRE2_SPTR)"(\\p{L}+)\\s+(\\d+)$", PCRE2_ZERO_TERMINATED,
      PCRE2_UTF | PCRE2_UCP, &error, &offset, NULL);
  CHECK(compiled);
  pcre2_match_data* matches = pcre2_match_data_create_from_pattern(compiled, NULL);
  CHECK(matches);
  const char* input = "FFB café 42";
  CHECK(pcre2_match(compiled, (PCRE2_SPTR)input, strlen(input), 0, 0, matches, NULL) == 3);
  PCRE2_UCHAR* capture = NULL;
  PCRE2_SIZE length = 0;
  CHECK(pcre2_substring_get_bynumber(matches, 1, &capture, &length) == 0);
  CHECK(length == strlen("café") && strcmp((char*)capture, "café") == 0);
  pcre2_substring_free(capture);
  pcre2_match_data_free(matches);
  pcre2_code_free(compiled);
  CHECK(!pcre2_compile((PCRE2_SPTR)"(", PCRE2_ZERO_TERMINATED, 0, &error, &offset, NULL) && error != 0);
  regex_t posix;
  CHECK(regcomp(&posix, "^FFB ([0-9]+)$", REG_EXTENDED) == 0);
  regmatch_t ranges[2];
  CHECK(regexec(&posix, "FFB 42", 2, ranges, 0) == 0);
  CHECK(ranges[1].rm_so == 4 && ranges[1].rm_eo == 6);
  regfree(&posix);
  error = regcomp(&posix, "(", REG_EXTENDED);
  CHECK(error != 0);
  char message[128];
  CHECK(regerror(error, &posix, message, sizeof(message)) > 1 && message[0]);
  puts("PCRE2: UTF/UCP captures, installed POSIX wrapper and invalid-pattern errors passed");
  return 0;
}

struct closure_state { unsigned calls; int valid; };
static double generic_callback(gpointer instance, gint number, const gchar* text, gdouble scale, gpointer opaque) {
  struct closure_state* state = opaque;
  ++state->calls;
  state->valid = instance == state && number == 7 && strcmp(text, "FFB") == 0 && scale == .25;
  return number + scale;
}
static gpointer thread_callback(gpointer queue) {
  g_async_queue_push(queue, GUINT_TO_POINTER(42));
  return GUINT_TO_POINTER(17);
}
static gboolean idle_callback(gpointer data) {
  ++*(unsigned*)data;
  return G_SOURCE_REMOVE;
}
static int glib_sdk(void) {
  GError* error = NULL;
  GRegex* regex = g_regex_new("(?<word>\\p{L}+) (?<number>\\d+)", G_REGEX_OPTIMIZE, 0, &error);
  CHECK(regex && !error);
  GMatchInfo* matches = NULL;
  CHECK(g_regex_match(regex, "café 42", 0, &matches));
  char* word = g_match_info_fetch_named(matches, "word");
  CHECK(word && strcmp(word, "café") == 0);
  g_free(word);
  g_match_info_free(matches);
  char* replaced = g_regex_replace_literal(regex, "café 42", -1, 0, "FFB", 0, &error);
  CHECK(replaced && !error && strcmp(replaced, "FFB") == 0);
  g_free(replaced);
  g_regex_unref(regex);
  CHECK(!g_regex_new("(", 0, 0, &error) && error);
  g_clear_error(&error);
  GAsyncQueue* queue = g_async_queue_new();
  GThread* thread = g_thread_new("ffb-sdk", thread_callback, queue);
  CHECK(GPOINTER_TO_UINT(g_async_queue_pop(queue)) == 42);
  CHECK(GPOINTER_TO_UINT(g_thread_join(thread)) == 17);
  g_async_queue_unref(queue);
  GMainContext* context = g_main_context_new();
  GSource* source = g_idle_source_new();
  unsigned idle_calls = 0;
  g_source_set_callback(source, idle_callback, &idle_calls, NULL);
  CHECK(g_source_attach(source, context) != 0);
  CHECK(g_main_context_iteration(context, TRUE) && idle_calls == 1);
  g_source_unref(source);
  g_main_context_unref(context);

  struct closure_state state = {0};
  GClosure* closure = g_cclosure_new(G_CALLBACK(generic_callback), &state, NULL);
  g_closure_ref(closure);
  g_closure_sink(closure);
  g_closure_set_marshal(closure, g_cclosure_marshal_generic);
  GValue args[4] = {G_VALUE_INIT,G_VALUE_INIT,G_VALUE_INIT,G_VALUE_INIT};
  g_value_init(&args[0], G_TYPE_POINTER); g_value_set_pointer(&args[0], &state);
  g_value_init(&args[1], G_TYPE_INT); g_value_set_int(&args[1], 7);
  g_value_init(&args[2], G_TYPE_STRING); g_value_set_string(&args[2], "FFB");
  g_value_init(&args[3], G_TYPE_DOUBLE); g_value_set_double(&args[3], .25);
  GValue result = G_VALUE_INIT;
  g_value_init(&result, G_TYPE_DOUBLE);
  g_closure_invoke(closure, &result, 4, args, NULL);
  CHECK(state.calls == 1 && state.valid && fabs(g_value_get_double(&result) - 7.25) < .000001);
  for (size_t i = 0; i < 4; ++i) g_value_unset(&args[i]);
  g_value_unset(&result);
  g_closure_unref(closure);
  GObject* object = g_object_new(G_TYPE_OBJECT, NULL);
  GWeakRef weak;
  g_weak_ref_init(&weak, object);
  g_object_unref(object);
  CHECK(g_weak_ref_get(&weak) == NULL);
  g_weak_ref_clear(&weak);
  puts("GLib/GObject: UTF regex, threads/main-context, real generic libffi marshaller and object lifetime passed");
  return 0;
}

static int gio_sdk(const char* filename) {
  const char payload[] = "FFB authored GIO converter and file payload";
  GError* error = NULL;
  GOutputStream* memory = g_memory_output_stream_new_resizable();
  GZlibCompressor* compressor = g_zlib_compressor_new(G_ZLIB_COMPRESSOR_FORMAT_ZLIB, 3);
  GOutputStream* output = g_converter_output_stream_new(memory, G_CONVERTER(compressor));
  gsize written = 0;
  CHECK(g_output_stream_write_all(output, payload, sizeof(payload), &written, NULL, &error));
  CHECK(!error && written == sizeof(payload));
  CHECK(g_output_stream_close(output, NULL, &error) && !error);
  const void* compressed = g_memory_output_stream_get_data(G_MEMORY_OUTPUT_STREAM(memory));
  gsize compressed_size = g_memory_output_stream_get_data_size(G_MEMORY_OUTPUT_STREAM(memory));
  CHECK(compressed && compressed_size > 0);
  GInputStream* input = g_memory_input_stream_new_from_data(compressed, compressed_size, NULL);
  GZlibDecompressor* decompressor = g_zlib_decompressor_new(G_ZLIB_COMPRESSOR_FORMAT_ZLIB);
  GInputStream* reader = g_converter_input_stream_new(input, G_CONVERTER(decompressor));
  char restored[sizeof(payload)];
  gsize read = 0;
  CHECK(g_input_stream_read_all(reader, restored, sizeof(restored), &read, NULL, &error));
  CHECK(!error && read == sizeof(payload) && memcmp(restored, payload, sizeof(payload)) == 0);
  char eof;
  CHECK(g_input_stream_read(reader, &eof, 1, NULL, &error) == 0 && !error);
  g_object_unref(reader); g_object_unref(input); g_object_unref(decompressor);
  g_object_unref(output); g_object_unref(memory); g_object_unref(compressor);
  GFile* file = g_file_new_for_path(filename);
  CHECK(g_file_replace_contents(file, payload, sizeof(payload), NULL, FALSE, G_FILE_CREATE_NONE, NULL, NULL, &error));
  CHECK(!error);
  char* loaded = NULL;
  gsize size = 0;
  CHECK(g_file_load_contents(file, NULL, &loaded, &size, NULL, &error));
  CHECK(!error && size == sizeof(payload) && memcmp(loaded, payload, sizeof(payload)) == 0);
  g_free(loaded);
  CHECK(g_file_delete(file, NULL, &error) && !error);
  g_object_unref(file);
  puts("GIO: owned memory/file streams, zlib conversion and exact bytes through EOF passed");
  return 0;
}

static int module_sdk(const char* filename) {
  CHECK(g_module_supported());
  GModule* module = g_module_open(filename, G_MODULE_BIND_LOCAL);
  CHECK(module);
  gpointer symbol = NULL;
  CHECK(g_module_symbol(module, "ffb_module_sum", &symbol) && symbol);
  int (*sum)(int,int) = (int (*)(int,int))symbol;
  CHECK(sum(17,25) == 42);
  CHECK(g_module_close(module));
  puts("GModule: owned module open, symbol invocation and close passed");
  return 0;
}

int main(int argc, char** argv) {
  CHECK(argc == 3);
  return ffi_sdk() || regex_sdk() || glib_sdk() || gio_sdk(argv[2]) || module_sdk(argv[1]);
}
