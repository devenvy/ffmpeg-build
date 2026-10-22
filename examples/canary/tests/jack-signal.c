/* Authored JACK dummy-server signal source for the MIT-licensed ffmpeg-build canary. */
#include <jack/jack.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static jack_port_t *output;
static unsigned long long frame;
static double rate;
static int process(jack_nframes_t count, void *unused) {
    (void)unused;
    float *samples = jack_port_get_buffer(output, count);
    for (jack_nframes_t i = 0; i < count; ++i)
        samples[i] = (float)(0.2 * sin(6.283185307179586 * 997.0 * frame++ / rate));
    return 0;
}
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    const char *server = getenv("JACK_DEFAULT_SERVER");
    if (!server) server = "default";
    jack_status_t status;
    jack_client_t *client = NULL;
    for (int attempt = 0; attempt < 50 && !client; ++attempt) {
        client = jack_client_open("ffb-signal", JackNoStartServer | JackServerName, &status, server);
        if (!client) usleep(100000);
    }
    if (!client) return 2;
    rate = jack_get_sample_rate(client);
    output = jack_port_register(client, "out", JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput, 0);
    if (!output || jack_set_process_callback(client, process, NULL) || jack_activate(client)) return 3;
    FILE *ready = fopen(argv[1], "w");
    if (!ready) return 4;
    fputs("ready", ready); fclose(ready);
    int connected = 0;
    for (int attempt = 0; attempt < 80; ++attempt) {
        if (!connected) {
            const char **ports = jack_get_ports(client, "ffb-capture:.*", JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput);
            if (ports) {
                for (unsigned int i = 0; ports[i]; ++i)
                    if (!jack_connect(client, jack_port_name(output), ports[i])) connected++;
                jack_free(ports);
            }
        }
        usleep(50000);
    }
    jack_client_close(client);
    return connected ? 0 : 5;
}
