#include <assert.h>
#include <libintl.h>
#include <locale.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  const char *singular = "owned message", *plural = "owned messages";
  assert(strcmp(textdomain(NULL), "messages") == 0);
  assert(strcmp(textdomain("owned-domain"), "owned-domain") == 0);
  assert(strcmp(textdomain(NULL), "owned-domain") == 0);
  assert(gettext(singular) == singular);
  assert(dgettext("owned-domain", singular) == singular);
  assert(dcgettext("owned-domain", singular, LC_MESSAGES) == singular);
  assert(ngettext(singular, plural, 1) == singular);
  assert(ngettext(singular, plural, 0) == plural);
  assert(dngettext("owned-domain", singular, plural, 2) == plural);
  assert(dcngettext("owned-domain", singular, plural, 1, LC_MESSAGES) == singular);
  assert(strcmp(bindtextdomain("owned-domain", "/owned"), "/dummy") == 0);
  assert(strcmp(bindtextdomain("owned-domain", NULL), "/dummy") == 0);
  assert(strcmp(bind_textdomain_codeset("owned-domain", "UTF-8"), "UTF-8") == 0);
  assert(bind_textdomain_codeset("owned-domain", NULL) == NULL);
  /* The native stub stores an empty name literally, unlike GNU gettext. */
  assert(strcmp(textdomain(""), "") == 0);
  assert(strcmp(textdomain("messages"), "messages") == 0);
  extern int _nl_msg_cat_cntr;
  _nl_msg_cat_cntr++;
  assert(_nl_msg_cat_cntr == 1);
  puts("Proxy gettext: nine public APIs, common mutable domain, public data, plural/category stubs and binding contracts passed");
  return 0;
}
