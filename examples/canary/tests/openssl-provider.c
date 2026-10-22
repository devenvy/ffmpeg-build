#include <openssl/evp.h>
#include <openssl/opensslv.h>
#include <openssl/provider.h>
#include <stdio.h>
#include <string.h>

/* Only public OpenSSL 3 APIs: compile against the test host's headers, then
 * link and run against the relocated library from this FFmpeg build. */
int main(void) {
    static const unsigned char expected[] = {
        0xa4, 0x48, 0x01, 0x7a, 0xaf, 0x21, 0xd8, 0x52,
        0x5f, 0xc1, 0x0a, 0xe8, 0x7a, 0xa6, 0x72, 0x9d
    };
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int size = 0;
    unsigned long version = OpenSSL_version_num();
    if (version < 0x30500000UL || version >= 0x30600000UL) {
        fprintf(stderr, "Expected the recipe's OpenSSL 3.5 library: %s\n",
                OpenSSL_version(OPENSSL_VERSION));
        return 1;
    }
    OSSL_PROVIDER *standard = OSSL_PROVIDER_load(NULL, "default");
    OSSL_PROVIDER *legacy = OSSL_PROVIDER_load(NULL, "legacy");
    if (!standard || !legacy) return 2;
    EVP_MD *md4 = EVP_MD_fetch(NULL, "MD4", "provider=legacy");
    if (!md4 || EVP_Digest("abc", 3, digest, &size, md4, NULL) != 1 ||
        size != sizeof(expected) || memcmp(digest, expected, size) != 0) return 3;
    EVP_MD_free(md4);
    if (OSSL_PROVIDER_unload(legacy) != 1 || OSSL_PROVIDER_unload(standard) != 1) return 4;
    puts("Relocated OpenSSL default/legacy providers and MD4 passed without module files");
    return 0;
}
