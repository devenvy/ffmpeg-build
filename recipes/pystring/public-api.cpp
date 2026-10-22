#include <pystring/pystring.h>
#include <cassert>
#include <iostream>
#include <string>
#include <vector>

int main() {
    std::vector<std::string> parts;
    pystring::split("owned::relative::config", parts, "::");
    assert((parts == std::vector<std::string>{"owned", "relative", "config"}));
    std::string joined = pystring::join("/", parts);
    assert(joined == "owned/relative/config");
    assert(pystring::replace(joined, "relative", "archive") == "owned/archive/config");
    assert(pystring::os::path::normpath_posix("/owned/a/../config/./look.cube") == "/owned/config/look.cube");
    parts.clear();
    pystring::splitlines("one\ntwo\r\nthree", parts);
    assert((parts == std::vector<std::string>{"one", "two", "three"}));
    std::cout << "Pystring: external string/vector allocation, split/join/replace and path normalization passed\n";
}
