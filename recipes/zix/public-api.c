#include <zix/btree.h>
#include <stdio.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Zix SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
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

int main(void) { return btree_sdk(); }
