#define _XOPEN_SOURCE_EXTENDED 1
#include <assert.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <curses.h>
#include <form.h>
#include <menu.h>
#include <panel.h>
#include <term.h>

static void curses_api(void) {
  assert(setlocale(LC_ALL, ""));
  SCREEN *first = newterm("xterm", stdout, stdin);
  assert(first && stdscr && curscr && newscr && cur_term);
  assert(LINES == 24 && COLS == 80 && ttytype[0]);
  assert(boolnames[0] && boolcodes[0] && boolfnames[0]);
  assert(numnames[0] && numcodes[0] && numfnames[0]);
  assert(strnames[0] && strcodes[0] && strfnames[0]);
  assert(cbreak() == OK && noecho() == OK && start_color() == OK);
  assert(COLORS > 0 && COLOR_PAIRS > 0);
  assert(set_escdelay(25) == OK && ESCDELAY == 25 && TABSIZE > 0);
  WINDOW *window = newwin(4, 20, 1, 1);
  assert(window && waddwstr(window, L"Owned \u03bb") == OK);
  wchar_t text[16] = {0};
  assert(mvwinnwstr(window, 0, 0, text, 7) == 7 && !wcsncmp(text, L"Owned \u03bb", 7));
  PANEL *panel = new_panel(window);
  assert(panel && panel_window(panel) == window);
  assert(move_panel(panel, 2, 3) == OK && hide_panel(panel) == OK && panel_hidden(panel));
  assert(show_panel(panel) == OK && !panel_hidden(panel));
  update_panels();
  assert(doupdate() == OK && del_panel(panel) == OK && delwin(window) == OK);
  ITEM *items[] = {new_item("first", "owned one"), new_item("second", "owned two"), NULL};
  assert(items[0] && items[1]);
  MENU *menu = new_menu(items);
  assert(menu && post_menu(menu) == E_OK && current_item(menu) == items[0]);
  assert(menu_driver(menu, REQ_DOWN_ITEM) == E_OK && current_item(menu) == items[1]);
  assert(unpost_menu(menu) == E_OK && free_menu(menu) == E_OK);
  assert(free_item(items[0]) == E_OK && free_item(items[1]) == E_OK);
  FIELD *fields[] = {new_field(1, 16, 10, 2, 0, 0), NULL};
  assert(fields[0]);
  FORM *form = new_form(fields);
  assert(form && post_form(form) == E_OK);
  for (const char *letter = "owned"; *letter; letter++) assert(form_driver(form, *letter) == E_OK);
  assert(form_driver(form, REQ_VALIDATION) == E_OK);
  assert(!strncmp(field_buffer(fields[0], 0), "owned", 5));
  assert(unpost_form(form) == E_OK && free_form(form) == E_OK && free_field(fields[0]) == E_OK);
  WINDOW *first_window = stdscr;
  TERMINAL *first_terminal = cur_term;
  assert(mvwaddstr(stdscr, 0, 0, "ONE") == OK && endwin() == OK);
  SCREEN *second = newterm("xterm", stdout, stdin);
  assert(second && stdscr != first_window && cur_term != first_terminal);
  WINDOW *second_window = stdscr;
  TERMINAL *second_terminal = cur_term;
  assert(mvwaddstr(stdscr, 0, 0, "TWO") == OK);
  assert(set_term(first) == second && stdscr == first_window && cur_term == first_terminal);
  assert((mvwinch(stdscr, 0, 0) & A_CHARTEXT) == 'O');
  assert(set_term(second) == first && stdscr == second_window && cur_term == second_terminal);
  assert((mvwinch(stdscr, 0, 0) & A_CHARTEXT) == 'T');
  assert(endwin() == OK);
  assert(set_term(first) == second);
  if (!isendwin()) assert(endwin() == OK);
  assert(isendwin());
  delscreen(second);
  delscreen(first);
  puts("Ncurses: wide Unicode/window/panel/menu/form APIs, public data, two-screen globals and paired ownership passed");
}

int main(void) {
  curses_api();
  return 0;
}
