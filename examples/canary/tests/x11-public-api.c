#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <X11/Xauth.h>
#include <X11/Xlib.h>
#include <X11/Xlib-xcb.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xext.h>
#include <X11/extensions/Xvlib.h>
#include <xcb/randr.h>
#include <xcb/shape.h>
#include <xcb/shm.h>
#include <xcb/xfixes.h>

static Display *display;
static Window window;
static unsigned int errors;
static unsigned int missing_extensions;
static int extension_handler(Display *owner, const char *name, const char *reason) {
  assert(owner == display && !strcmp(name, "XVideo") && !strcmp(reason, X_EXTENSION_MISSING));
  missing_extensions++;
  return 0;
}
static int error_handler(Display *owner, XErrorEvent *event) {
  (void)owner;
  fprintf(stderr, "X error %u request %u\n", event->error_code, event->request_code);
  errors++;
  return 0;
}
static void authority(void) {
  FILE *file = tmpfile();
  assert(file);
  Xauth original = {FamilyWild, 0, "", 2, "92", 18, "MIT-MAGIC-COOKIE-1", 16, "owned01234567890x"};
  assert(XauWriteAuth(file, &original));
  rewind(file);
  Xauth *copy = XauReadAuth(file);
  assert(copy && copy->family == original.family && copy->data_length == original.data_length);
  assert(memcmp(copy->data, original.data, original.data_length) == 0);
  assert(copy->number_length == original.number_length && !memcmp(copy->number, original.number, original.number_length));
  XauDisposeAuth(copy);
  assert(!XauReadAuth(file));
  assert(fclose(file) == 0);
}
static void extensions(xcb_connection_t *connection, int reverse) {
  xcb_extension_t *ids[] = {&xcb_shm_id, &xcb_shape_id, &xcb_xfixes_id, &xcb_randr_id};
  const char *names[] = {"MIT-SHM", "SHAPE", "XFIXES", "RANDR"};
  for (int offset = 0; offset < 4; offset++) {
    int index = reverse ? 3 - offset : offset;
    xcb_prefetch_extension_data(connection, ids[index]);
  }
  for (int index = 0; index < 4; index++) {
    const xcb_query_extension_reply_t *cached = xcb_get_extension_data(connection, ids[index]);
    xcb_query_extension_cookie_t request = xcb_query_extension(connection, (uint16_t)strlen(names[index]), names[index]);
    xcb_query_extension_reply_t *raw = xcb_query_extension_reply(connection, request, NULL);
    assert(raw && cached && raw->present && cached->present);
    assert(cached->major_opcode == raw->major_opcode && cached->first_event == raw->first_event && cached->first_error == raw->first_error);
    free(raw);
  }
}
static void pixel(unsigned long expected) {
  XImage *image = XGetImage(display, window, 0, 0, 1, 1, AllPlanes, ZPixmap);
  assert(image && (XGetPixel(image, 0, 0) & 0xffffff) == expected);
  XDestroyImage(image);
}
static void bridge(void) {
  xcb_connection_t *borrowed = XGetXCBConnection(display);
  assert(borrowed && !xcb_connection_has_error(borrowed));
  int screen = 0;
  xcb_connection_t *separate = xcb_connect(NULL, &screen);
  assert(separate && !xcb_connection_has_error(separate));
  extensions(separate, 1);
  extensions(borrowed, 0);
  xcb_disconnect(separate);
  XSync(display, False);
  while (XPending(display)) {
    XEvent event;
    XNextEvent(display, &event);
  }
  XSetEventQueueOwner(display, XCBOwnsEventQueue);
  xcb_gcontext_t gc = xcb_generate_id(borrowed);
  uint32_t color = 0xff;
  assert(!xcb_request_check(borrowed, xcb_create_gc_checked(borrowed, gc, (xcb_drawable_t)window, XCB_GC_FOREGROUND, &color)));
  xcb_rectangle_t rectangle = {0, 0, 64, 64};
  assert(!xcb_request_check(borrowed, xcb_poly_fill_rectangle_checked(borrowed, (xcb_drawable_t)window, gc, 1, &rectangle)));
  assert(!xcb_request_check(borrowed, xcb_free_gc_checked(borrowed, gc)));
  xcb_get_input_focus_reply_t *reply = xcb_get_input_focus_reply(borrowed, xcb_get_input_focus(borrowed), NULL);
  assert(reply);
  free(reply);
  XSetEventQueueOwner(display, XlibOwnsEventQueue);
  pixel(0xff);
  /* The connection belongs to Display; only XCloseDisplay may disconnect it. */
}
static void shared_memory(void) {
  int major, minor;
  Bool pixmaps;
  assert(XShmQueryVersion(display, &major, &minor, &pixmaps) && major >= 1);
  XShmSegmentInfo segment;
  memset(&segment, 0, sizeof(segment));
  int screen = DefaultScreen(display);
  XImage *image = XShmCreateImage(display, DefaultVisual(display, screen), (unsigned int)DefaultDepth(display, screen), ZPixmap, NULL, &segment, 64, 64);
  assert(image);
  size_t bytes = (size_t)image->bytes_per_line * (size_t)image->height;
  segment.shmid = shmget(IPC_PRIVATE, bytes, IPC_CREAT | 0600);
  assert(segment.shmid >= 0);
  segment.shmaddr = shmat(segment.shmid, NULL, 0);
  assert(segment.shmaddr != (char *)-1);
  segment.readOnly = False;
  image->data = segment.shmaddr;
  memset(image->data, 0, bytes);
  for (int y = 0; y < image->height; y++) {
    for (int x = 0; x < image->width; x++) XPutPixel(image, x, y, 0xff00);
  }
  assert(XShmAttach(display, &segment));
  XSync(display, False);
  assert(!errors);
  GC gc = XCreateGC(display, window, 0, NULL);
  assert(gc && XShmPutImage(display, window, gc, image, 0, 0, 0, 0, 64, 64, False));
  XSync(display, False);
  pixel(0xff00);
  assert(XShmDetach(display, &segment));
  XSync(display, False);
  image->data = NULL;
  XDestroyImage(image);
  assert(shmdt(segment.shmaddr) == 0 && shmctl(segment.shmid, IPC_RMID, NULL) == 0);
  XFreeGC(display, gc);
}
static void *threaded(void *opaque) {
  (void)opaque;
  for (unsigned int index = 0; index < 100; index++) {
    XWindowAttributes attributes;
    assert(XGetWindowAttributes(display, window, &attributes));
    assert(attributes.width == 64 && attributes.height == 64);
    int major, minor;
    Bool pixmaps;
    assert(XShmQueryVersion(display, &major, &minor, &pixmaps));
  }
  return NULL;
}
int main(void) {
  authority();
  assert(XInitThreads());
  display = XOpenDisplay(NULL);
  assert(display);
  XSetErrorHandler(error_handler);
  if (getenv("FFB_XV_DISABLED")) {
    XextErrorHandler original = XSetExtensionErrorHandler(extension_handler);
    unsigned int version, revision, request, event, error;
    assert(XvQueryExtension(display, &version, &revision, &request, &event, &error) == XvBadExtension);
    assert(missing_extensions == 1);
    XSetExtensionErrorHandler(original);
    XCloseDisplay(display);
    puts("Xv: missing-extension callback crosses the selected shared Xext owner correctly");
    return 0;
  }
  int screen = DefaultScreen(display);
  window = XCreateSimpleWindow(display, RootWindow(display, screen), 8, 8, 64, 64, 0, 0, 0);
  assert(window);
  XMapWindow(display, window);
  GC gc = XCreateGC(display, window, 0, NULL);
  assert(gc);
  XSetForeground(display, gc, 0xff0000);
  XFillRectangle(display, window, gc, 0, 0, 64, 64);
  XSync(display, False);
  pixel(0xff0000);
  bridge();
  shared_memory();
  unsigned int version, revision, request, event, error;
  assert(XvQueryExtension(display, &version, &revision, &request, &event, &error) == Success);
  unsigned int count = 0;
  XvAdaptorInfo *adaptors = NULL;
  assert(XvQueryAdaptors(display, RootWindow(display, screen), &count, &adaptors) == Success);
  if (adaptors) XvFreeAdaptorInfo(adaptors);
  pthread_t first, second;
  assert(pthread_create(&first, NULL, threaded, NULL) == 0 && pthread_create(&second, NULL, threaded, NULL) == 0);
  assert(pthread_join(first, NULL) == 0 && pthread_join(second, NULL) == 0);
  XFreeGC(display, gc);
  XDestroyWindow(display, window);
  XSync(display, False);
  assert(!errors);
  XCloseDisplay(display);
  printf("X11 SDK: Xauth record lifetime, owned pixels, Xlib/XCB cache/queue bridge, MIT-SHM, threaded locking and Xv query passed (%u adaptors; no XVideo output claimed)\n", count);
  return 0;
}
