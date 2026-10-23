#include <serd/serd.h>
#include <stdio.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Serd SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
typedef struct { unsigned count; int valid; } State;
static SerdStatus statement(void *opaque, SerdStatementFlags flags, const SerdNode *graph,
                            const SerdNode *subject, const SerdNode *predicate,
                            const SerdNode *object, const SerdNode *datatype, const SerdNode *language) {
  (void)flags; (void)graph; (void)datatype; (void)language;
  State *state = opaque;
  state->count++;
  state->valid = subject->type == SERD_URI && predicate->type == SERD_URI &&
    !strcmp((const char *)subject->buf, "urn:ffb:s") &&
    !strcmp((const char *)predicate->buf, "urn:ffb:p") &&
    object->type == SERD_LITERAL && object->n_bytes == 3 &&
    !strcmp((const char *)object->buf, "FFB");
  return state->valid ? SERD_SUCCESS : SERD_ERR_BAD_ARG;
}
int main(void) {
  State state = {0};
  SerdReader *reader = serd_reader_new(SERD_TURTLE, &state, NULL, NULL, NULL, statement, NULL);
  CHECK(reader);
  serd_reader_set_strict(reader, true);
  CHECK(serd_reader_read_string(reader, (const uint8_t *)"<urn:ffb:s> <urn:ffb:p> \"FFB\" .") == SERD_SUCCESS);
  CHECK(state.count == 1 && state.valid);
  CHECK(serd_reader_read_string(reader, (const uint8_t *)"<unterminated") != SERD_SUCCESS);
  CHECK(state.count == 1);
  serd_reader_free(reader);
  puts("Serd: owned Turtle statement, exact URI/literal callback and malformed-input rejection passed");
  return 0;
}
