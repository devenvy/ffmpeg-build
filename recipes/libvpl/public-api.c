#include <vpl/mfx.h>
#include <vpl/mfxdispatcher.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    MFXUnload(NULL);
    mfxLoader loader = MFXLoad();
    assert(loader);
    mfxConfig config = MFXCreateConfig(loader);
    assert(config);
    mfxVariant property = {0};
    property.Version.Version = MFX_VARIANT_VERSION;
    property.Type = MFX_VARIANT_TYPE_U32;
    property.Data.U32 = MFX_IMPL_TYPE_HARDWARE;
    assert(MFXSetConfigFilterProperty(config, (const mfxU8 *)"mfxImplDescription.Impl", property) == MFX_ERR_NONE);
    property.Type = MFX_VARIANT_TYPE_U16;
    assert(MFXSetConfigFilterProperty(config, (const mfxU8 *)"mfxImplDescription.Impl", property) == MFX_ERR_UNSUPPORTED);
    MFXUnload(loader);

    loader = MFXLoad();
    assert(loader);
    config = MFXCreateConfig(loader);
    assert(config);
    property.Type = MFX_VARIANT_TYPE_U32;
    property.Data.U32 = MFX_IMPL_TYPE_SOFTWARE;
    assert(MFXSetConfigFilterProperty(config, (const mfxU8 *)"mfxImplDescription.Impl", property) == MFX_ERR_NONE);
    unsigned count = 0;
    for (mfxU32 index = 0; index < 16; ++index) {
        mfxHDL description = NULL;
        mfxStatus status = MFXEnumImplementations(loader, index, MFX_IMPLCAPS_IMPLDESCSTRUCTURE, &description);
        if (status == MFX_ERR_NOT_FOUND) break;
        assert(status == MFX_ERR_NONE && description);
        const mfxImplDescription *implementation = description;
        assert(implementation->Impl == MFX_IMPL_TYPE_SOFTWARE);
        assert(strcmp(implementation->ImplName, "Stub Implementation") == 0);
        assert(implementation->VendorImplID == 0xffffu);
        assert(implementation->ApiVersion.Major >= 2);
        assert(MFXDispReleaseImplDescription(loader, description) == MFX_ERR_NONE);
        ++count;
    }
    assert(count > 0 && count < 16);
    mfxSession session = NULL;
    assert(MFXCreateSession(loader, 0, &session) == MFX_ERR_NONE && session);
    mfxVersion version = {0};
    assert(MFXQueryVersion(session, &version) == MFX_ERR_NONE && version.Major >= 2);
    assert(MFXClose(session) == MFX_ERR_NONE);
    MFXUnload(loader);
    puts("VPL: native upstream stub dispatch, descriptors, session/version/close, filter validation and loader-owned config lifetime passed");
}
