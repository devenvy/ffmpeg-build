#include <stdint.h>
#include <libmodplug/stdafx.h>
#include <libmodplug/sndfile.h>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    std::ifstream input(argv[1], std::ios::binary);
    std::vector<unsigned char> data((std::istreambuf_iterator<char>(input)), {});
    CSoundFile module;
    if (!module.Create(data.data(), static_cast<DWORD>(data.size())))
        return 2;
    std::vector<unsigned char> output(16384);
    const auto read = module.Read(output.data(), static_cast<UINT>(output.size()));
    module.Destroy();
    return read > 0 ? 0 : 3;
}
