#include <srt/udt.h>
#include <cassert>
#include <cstdio>
#include <set>
#include <sstream>
#include <string>
#include <vector>

int main() {
  assert(UDT::startup() == 0);
  const SRTSOCKET socket = srt_create_socket();
  assert(socket != UDT::INVALID_SOCK);
  // Native 1.5.7 declares the legacy UDT constructor without defining it.
  // Create sockets through its supported C API, as FFmpeg does.
  const SRTSOCKET c_socket = srt_create_socket();
  assert(c_socket != UDT::INVALID_SOCK);
  assert(srt_getsockstate(c_socket) == SRTS_INIT);
  assert(srt_close(c_socket) == 0);
  const std::string stream = "ffb-installed-cxx-sdk";
  assert(srt::setstreamid(socket, stream));
  assert(srt::getstreamid(socket) == stream);
  assert(UDT::getsockstate(socket) == SRTS_INIT);
  std::ostringstream log;
  srt::setlogstream(log);
  srt::resetlogfa(std::set<srt_logging::LogFA>{});
  std::vector<SRTSOCKET> descriptors{socket}, read, write, except;
  (void) UDT::selectEx(descriptors, &read, &write, &except, 0);
  std::printf("Installed SRT C++ SDK and public logger %p passed\n", (void *)&srt_logger_config);
  assert(UDT::close(socket) == 0);
  assert(UDT::cleanup() == 0);
}
