#include <sratom/sratom.h>
#include <lv2/atom/atom.h>
#include <lv2/atom/forge.h>
#include <lv2/atom/util.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Sratom SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
typedef struct { char *uris[128]; size_t count; } Map;
static LV2_URID map_uri(LV2_URID_Map_Handle opaque, const char *uri) {
  Map *map = opaque;
  for (size_t index = 0; index < map->count; index++)
    if (!strcmp(map->uris[index], uri)) return index + 1;
  if (map->count == 128) return 0;
  char *copy = strdup(uri);
  if (!copy) return 0;
  map->uris[map->count++] = copy;
  return map->count;
}
static const char *unmap_uri(LV2_URID_Unmap_Handle opaque, LV2_URID id) {
  Map *map = opaque;
  return id && id <= map->count ? map->uris[id - 1] : NULL;
}
static int atom_sdk(void) {
  Map state = {0};
  LV2_URID_Map map = {&state, map_uri};
  LV2_URID_Unmap unmap = {&state, unmap_uri};
  Sratom *sratom = sratom_new(&map);
  CHECK(sratom != NULL);
  const SerdNode subject = serd_node_from_string(SERD_URI, (const uint8_t *)"urn:ffb:subject");
  const SerdNode predicate = serd_node_from_string(SERD_URI, (const uint8_t *)"urn:ffb:predicate");
  uint8_t buffer[1024] = {0};
  LV2_Atom_Forge forge;
  lv2_atom_forge_init(&forge, &map);
  lv2_atom_forge_set_buffer(&forge, buffer, sizeof(buffer));
  LV2_Atom_Forge_Frame tuple;
  CHECK(lv2_atom_forge_tuple(&forge, &tuple));
  CHECK(lv2_atom_forge_int(&forge, 42));
  CHECK(lv2_atom_forge_string(&forge, "FFB owned atom", 14));
  CHECK(lv2_atom_forge_double(&forge, 7.25));
  lv2_atom_forge_pop(&forge, &tuple);
  const LV2_Atom *original = (const LV2_Atom *)buffer;
  char *turtle = sratom_to_turtle(sratom, &unmap, "urn:ffb:base", &subject, &predicate,
                                 original->type, original->size, LV2_ATOM_BODY_CONST(original));
  CHECK(turtle && strstr(turtle, "FFB owned atom"));
  LV2_Atom *restored = sratom_from_turtle(sratom, "urn:ffb:base", &subject, &predicate, turtle);
  CHECK(restored && restored->type == original->type && restored->size == original->size);
  size_t index = 0;
  LV2_ATOM_TUPLE_FOREACH((LV2_Atom_Tuple *)restored, atom) {
    if (index == 0) CHECK(atom->type == forge.Int && atom->size == sizeof(int32_t) && ((LV2_Atom_Int *)atom)->body == 42);
    else if (index == 1) CHECK(atom->type == forge.String && atom->size == 15 && !strcmp((const char *)LV2_ATOM_BODY(atom), "FFB owned atom"));
    else if (index == 2) CHECK(atom->type == forge.Double && atom->size == sizeof(double) && ((LV2_Atom_Double *)atom)->body == 7.25);
    index++;
  }
  CHECK(index == 3);
  free(restored);
  free(turtle);
  sratom_free(sratom);
  for (size_t item = 0; item < state.count; item++) free(state.uris[item]);
  puts("Sratom/Serd/Sord: owned URID callbacks, typed tuple to Turtle and back, values and ownership passed");
  return 0;
}

int main(void) { return atom_sdk(); }
