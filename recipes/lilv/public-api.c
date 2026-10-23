#include <sratom/sratom.h>
#include <lilv/lilv.h>
#include <lv2/atom/atom.h>
#include <lv2/atom/forge.h>
#include <lv2/atom/util.h>
#include <zix/btree.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "LV2 stack SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
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
static int compare(const void *left, const void *right, const void *data) {
  (void)data;
  int a = *(const int *)left, b = *(const int *)right;
  return (a > b) - (a < b);
}
static int btree_sdk(void) {
  ZixBTree *tree = zix_btree_new(NULL, compare, NULL);
  CHECK(tree);
  int values[1025];
  for (int index = 1024; index >= 0; index--) {
    values[index] = index;
    CHECK(zix_btree_insert(tree, &values[index]) == ZIX_STATUS_SUCCESS);
  }
  CHECK(zix_btree_size(tree) == 1025);
  CHECK(zix_btree_insert(tree, &values[42]) == ZIX_STATUS_EXISTS);
  for (int index = 0; index < 1025; index++) {
    ZixBTreeIter found;
    CHECK(zix_btree_find(tree, &index, &found) == ZIX_STATUS_SUCCESS);
    CHECK(*(int *)zix_btree_get(found) == index);
    void *removed = NULL;
    ZixBTreeIter next;
    CHECK(zix_btree_remove(tree, &index, &removed, &next) == ZIX_STATUS_SUCCESS);
    CHECK(removed == &values[index]);
    CHECK(zix_btree_find(tree, &index, &found) == ZIX_STATUS_NOT_FOUND);
  }
  CHECK(zix_btree_size(tree) == 0);
  zix_btree_free(tree, NULL, NULL);
  puts("Zix: owned 1025-element B-tree split, lookup, duplicates, removal and missing keys passed");
  return 0;
}
static int host_sdk(void) {
  LilvWorld *world = lilv_world_new();
  CHECK(world);
  lilv_world_load_all(world);
  LilvNode *uri = lilv_new_uri(world, "urn:ffmpeg-build:test:gain");
  CHECK(uri);
  const LilvPlugin *plugin = lilv_plugins_get_by_uri(lilv_world_get_all_plugins(world), uri);
  CHECK(plugin && lilv_plugin_get_num_ports(plugin) == 3);
  LilvInstance *instance = lilv_plugin_instantiate(plugin, 48000, NULL);
  CHECK(instance);
  float input[] = {.5, -.25, .125, 0}, output[4] = {0}, gain = .25;
  lilv_instance_connect_port(instance, 0, input);
  lilv_instance_connect_port(instance, 1, output);
  lilv_instance_connect_port(instance, 2, &gain);
  lilv_instance_activate(instance);
  for (int run = 0; run < 2; run++) {
    lilv_instance_run(instance, 4);
    for (int index = 0; index < 4; index++) CHECK(output[index] == input[index] * gain);
    gain = -.5;
  }
  lilv_instance_deactivate(instance);
  lilv_instance_free(instance);
  lilv_node_free(uri);
  lilv_world_free(world);
  puts("Lilv: owned world/plugin lifecycle, descriptor instantiation, ports, changed gain and cleanup passed");
  return 0;
}
int main(void) { return host_sdk() || atom_sdk() || btree_sdk(); }
