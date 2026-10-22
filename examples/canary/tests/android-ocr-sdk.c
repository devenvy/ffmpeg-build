#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/pixfmt.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(int status) {
  if (status < 0) {
    char error[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(status, error, sizeof(error));
    fprintf(stderr, "FFmpeg SDK: %s\n", error);
  }
  assert(status >= 0);
}

int main(int argc, char **argv) {
  assert(argc == 3);
  FILE *file = fopen(argv[1], "rb");
  assert(file);
  char magic[3];
  int width, height, maximum;
  assert(fscanf(file, "%2s%d%d%d", magic, &width, &height, &maximum) == 4);
  assert(strcmp(magic, "P5") == 0 && width == 1100 && height == 180 && maximum == 255);
  assert(fgetc(file) == '\n');
  AVFrame *input = av_frame_alloc(), *output = av_frame_alloc();
  assert(input && output);
  input->format = AV_PIX_FMT_GRAY8;
  input->width = width;
  input->height = height;
  input->pts = 0;
  check(av_frame_get_buffer(input, 32));
  for (int row = 0; row < height; row++) {
    assert(fread(input->data[0] + row * input->linesize[0], 1, width, file) == (size_t)width);
  }
  assert(fgetc(file) == EOF && fclose(file) == 0);
  AVFilterGraph *graph = avfilter_graph_alloc();
  assert(graph);
  AVFilterContext *source, *ocr, *sink;
  char parameters[256];
  snprintf(parameters, sizeof(parameters), "video_size=%dx%d:pix_fmt=%d:time_base=1/1:pixel_aspect=1/1",
           width, height, AV_PIX_FMT_GRAY8);
  check(avfilter_graph_create_filter(&source, avfilter_get_by_name("buffer"), "owned-input", parameters, NULL, graph));
  snprintf(parameters, sizeof(parameters), "datapath=%s:language=eng", argv[2]);
  check(avfilter_graph_create_filter(&ocr, avfilter_get_by_name("ocr"), "owned-ocr", parameters, NULL, graph));
  check(avfilter_graph_create_filter(&sink, avfilter_get_by_name("buffersink"), "owned-output", NULL, NULL, graph));
  check(avfilter_link(source, 0, ocr, 0));
  check(avfilter_link(ocr, 0, sink, 0));
  check(avfilter_graph_config(graph, NULL));
  check(av_buffersrc_add_frame_flags(source, input, AV_BUFFERSRC_FLAG_KEEP_REF));
  check(av_buffersink_get_frame(sink, output));
  const AVDictionaryEntry *text = av_dict_get(output->metadata, "lavfi.ocr.text", NULL, 0);
  assert(text && strstr(text->value, "HELLO WORLD 123"));
  assert(output->width == width && output->height == height && output->format == AV_PIX_FMT_GRAY8);
  for (int row = 0; row < height; row++) {
    assert(memcmp(input->data[0] + row * input->linesize[0], output->data[0] + row * output->linesize[0], width) == 0);
  }
  av_frame_unref(output);
  check(av_buffersrc_add_frame_flags(source, NULL, 0));
  assert(av_buffersink_get_frame(sink, output) == AVERROR_EOF);
  av_frame_free(&input);
  av_frame_free(&output);
  avfilter_graph_free(&graph);
  puts("Android FFmpeg SDK: owned Tesseract text recognition, exact unchanged pixels and natural filter EOF passed");
  return 0;
}
