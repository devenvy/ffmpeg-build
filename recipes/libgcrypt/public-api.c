#include <gcrypt.h>
#include <string.h>

int main(void)
{
    static const unsigned char expected[32] = {
        0x3a, 0x98, 0x5d, 0xa7, 0x4f, 0xe2, 0x25, 0xb2,
        0x04, 0x5c, 0x17, 0x2d, 0x6b, 0xd3, 0x90, 0xbd,
        0x85, 0x5f, 0x08, 0x6e, 0x3e, 0x9d, 0x52, 0x5b,
        0x46, 0xbf, 0xe2, 0x45, 0x11, 0x43, 0x15, 0x32
    };
    unsigned char digest[32], first[32], second[32];

    if (!gcry_check_version(NULL)) return 1;
    if (gcry_control(GCRYCTL_DISABLE_SECMEM, 0)) return 2;
    if (gcry_control(GCRYCTL_INITIALIZATION_FINISHED, 0)) return 3;
    if (gcry_md_test_algo(GCRY_MD_SHA3_256)) return 4;
    gcry_md_hash_buffer(GCRY_MD_SHA3_256, digest, "abc", 3);
    if (memcmp(digest, expected, sizeof digest)) return 5;
    gcry_randomize(first, sizeof first, GCRY_STRONG_RANDOM);
    gcry_randomize(second, sizeof second, GCRY_STRONG_RANDOM);
    return memcmp(first, second, sizeof first) == 0 ? 6 : 0;
}
