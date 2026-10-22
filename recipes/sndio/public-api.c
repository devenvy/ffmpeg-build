#include <sndio.h>
#include <assert.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { FRAMES = 4800, BYTES = FRAMES * 2 };
static void transfer(unsigned mode) {
    struct sio_hdl *handle = sio_open("rsnd/0", mode, 0);
    assert(handle);
    struct sio_par parameters;
    sio_initpar(&parameters);
    parameters.bits = 16;
    parameters.bps = 2;
    parameters.sig = 1;
    parameters.le = 1;
    parameters.rate = 48000;
    parameters.pchan = parameters.rchan = 1;
    parameters.appbufsz = 480;
    assert(sio_setpar(handle, &parameters));
    assert(sio_getpar(handle, &parameters));
    assert(parameters.bits == 16 && parameters.bps == 2 && parameters.le == 1);
    assert(parameters.rate == 48000);
    assert((mode == SIO_REC ? parameters.rchan : parameters.pchan) == 1);
    int count = sio_nfds(handle);
    assert(count > 0 && count <= 16);
    struct pollfd descriptors[16];
    int events = mode == SIO_REC ? POLLIN : POLLOUT;
    assert(sio_start(handle));
    int used = sio_pollfd(handle, descriptors, events);
    assert(used > 0 && used <= count);
    assert(poll(descriptors, used, 1000) > 0);
    assert(sio_revents(handle, descriptors) & events);
    unsigned char samples[BYTES];
    for (int i = 0; i < BYTES; ++i) samples[i] = (unsigned char)((i * 17 + 31) % 251);
    size_t done = 0;
    while (done < sizeof(samples)) {
        size_t result = mode == SIO_REC ? sio_read(handle, samples + done, sizeof(samples) - done)
                                        : sio_write(handle, samples + done, sizeof(samples) - done);
        assert(result > 0 && !sio_eof(handle));
        done += result;
    }
    if (mode == SIO_REC)
        for (int i = 0; i < BYTES; ++i) assert(samples[i] == (unsigned char)((i * 17 + 31) % 251));
    assert(sio_stop(handle));
    sio_close(handle);
}
int main(void) {
    transfer(SIO_REC);
    transfer(SIO_PLAY);
    assert(sio_open("rsnd/0,invalid", SIO_PLAY, 0) == NULL);
    assert(mio_open("rmidi/missing", MIO_OUT, 1) == NULL);
    assert(sioctl_open("rsnd/missing", SIOCTL_READ, 1) == NULL);
    puts("sndio: configured ALSA software PCM capture/playback, exact samples, parameters and lifetime passed");
    return 0;
}
