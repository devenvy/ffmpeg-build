#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <shaderc/shaderc.h>

static unsigned resolves, releases;
static shaderc_include_result *resolve_include(void *user, const char *requested,
    int type, const char *requesting, size_t depth) {
  (void)user; (void)type;
  assert(strcmp(requested, "owned.glsl") == 0);
  assert(requesting && depth > 0);
  shaderc_include_result *result = calloc(1, sizeof(*result));
  assert(result);
  result->source_name = "owned.glsl";
  result->source_name_length = strlen(result->source_name);
  result->content = "#define OWNED_VALUE 17u\n";
  result->content_length = strlen(result->content);
  resolves++;
  return result;
}
static void release_include(void *user, shaderc_include_result *result) {
  (void)user;
  releases++;
  free(result);
}
int main(void) {
  shaderc_compiler_t compiler = shaderc_compiler_initialize();
  shaderc_compile_options_t original = shaderc_compile_options_initialize();
  assert(compiler && original);
  shaderc_compile_options_add_macro_definition(original, "EXTRA", 5, "3u", 2);
  shaderc_compile_options_set_target_env(original, shaderc_target_env_vulkan,
      shaderc_env_version_vulkan_1_2);
  shaderc_compile_options_set_include_callbacks(original, resolve_include, release_include, NULL);
  shaderc_compile_options_t options = shaderc_compile_options_clone(original);
  assert(options);
  shaderc_compile_options_release(original);
  const char source[] = "#version 450\n"
    "#extension GL_GOOGLE_include_directive : require\n"
    "#include \"owned.glsl\"\n"
    "layout(local_size_x=1) in;\n"
    "layout(set=0,binding=0,std430) buffer Output { uint result; };\n"
    "void main() { result = OWNED_VALUE + EXTRA; }\n";
  shaderc_compilation_result_t result = shaderc_compile_into_spv(compiler,
      source, strlen(source), shaderc_compute_shader, "owned.comp", "main", options);
  assert(result && shaderc_result_get_compilation_status(result) == shaderc_compilation_status_success);
  size_t length = shaderc_result_get_length(result);
  assert(length >= sizeof(uint32_t) && length % sizeof(uint32_t) == 0);
  uint32_t magic;
  memcpy(&magic, shaderc_result_get_bytes(result), sizeof(magic));
  assert(magic == UINT32_C(0x07230203) && resolves > 0 && resolves == releases);
  shaderc_result_release(result);
  const char invalid[] = "#version 450\nvoid main() { missing_symbol; }\n";
  result = shaderc_compile_into_spv(compiler, invalid, strlen(invalid),
      shaderc_compute_shader, "invalid.comp", "main", options);
  assert(result && shaderc_result_get_compilation_status(result) != shaderc_compilation_status_success);
  assert(shaderc_result_get_num_errors(result) > 0 && strlen(shaderc_result_get_error_message(result)) > 0);
  shaderc_result_release(result);
  shaderc_compile_options_release(options);
  shaderc_compiler_release(compiler);
  return 0;
}
