#include <sord/sord.h>
#include <stdio.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Sord SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
int main(void) {
  SordWorld *world = sord_world_new();
  CHECK(world);
  SordModel *model = sord_new(world, SORD_SPO | SORD_OPS, false);
  CHECK(model);
  SordNode *subject = sord_new_uri(world, (const uint8_t *)"urn:ffb:s");
  SordNode *predicate = sord_new_uri(world, (const uint8_t *)"urn:ffb:p");
  SordNode *object = sord_new_literal(world, NULL, (const uint8_t *)"FFB", NULL);
  CHECK(subject && predicate && object);
  const SordQuad quad = {subject, predicate, object, NULL};
  CHECK(sord_add(model, quad));
  CHECK(sord_num_quads(model) == 1 && sord_contains(model, quad));
  CHECK(!sord_add(model, quad) && sord_num_quads(model) == 1);
  SordIter *iterator = sord_begin(model);
  CHECK(iterator && !sord_iter_end(iterator));
  SordQuad found;
  sord_iter_get(iterator, found);
  CHECK(found[0] == subject && found[1] == predicate && found[2] == object);
  CHECK(!strcmp((const char *)sord_node_get_string(found[2]), "FFB"));
  sord_iter_free(iterator);
  sord_remove(model, quad);
  CHECK(sord_num_quads(model) == 0 && !sord_contains(model, quad));
  sord_free(model);
  sord_node_free(world, subject);
  sord_node_free(world, predicate);
  sord_node_free(world, object);
  sord_world_free(world);
  puts("Sord: owned indexed model, exact nodes, duplicate/absent quads and paired lifetime passed");
  return 0;
}
