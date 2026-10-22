#include <srt/udt.h>
#include <cassert>
#include <cstdio>
#include <set>
#include <sstream>
#include <string>
#include <vector>

int main() {
  assert(UDT::startup() == 0);
  // Upstream 1.5.7 declares UDT::socket() but supplies no definition. Use its
  // maintained C constructor while exercising the real installed C++ SDK below.
  const SRTSOCKET socket = srt_create_socket();
  assert(socket != UDT::INVALID_SOCK);
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
