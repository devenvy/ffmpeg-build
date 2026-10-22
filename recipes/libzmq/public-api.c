#include <zmq.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  void *context = zmq_ctx_new();
  assert(context);
  void *first = zmq_socket(context, ZMQ_PAIR);
  void *second = zmq_socket(context, ZMQ_PAIR);
  assert(first && second);
  int timeout = 5000;
  assert(zmq_setsockopt(second, ZMQ_RCVTIMEO, &timeout, sizeof timeout) == 0);
  assert(zmq_bind(first, "inproc://ffb-installed-c-sdk") == 0);
  assert(zmq_connect(second, "inproc://ffb-installed-c-sdk") == 0);
  const char payload[] = "FFB-installed-SDK";
  assert(zmq_send(first, payload, sizeof payload, 0) == sizeof payload);
  char received[sizeof payload];
  assert(zmq_recv(second, received, sizeof received, 0) == sizeof payload);
  assert(memcmp(payload, received, sizeof payload) == 0);
  assert(zmq_close(first) == 0);
  assert(zmq_close(second) == 0);
  assert(zmq_ctx_term(context) == 0);
  puts("Installed ZeroMQ C SDK complete message and thread shutdown passed");
  return 0;
}
