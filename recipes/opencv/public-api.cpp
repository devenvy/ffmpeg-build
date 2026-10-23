#include <cassert>
#include <cstdio>
#include <exception>
#include <opencv2/core.hpp>
#include <opencv2/core/core_c.h>
#include <opencv2/imgproc.hpp>
#include <opencv2/imgproc/imgproc_c.h>

class TrackedAllocator final : public cv::MatAllocator {
public:
  mutable int allocated = 0;
  mutable int freed = 0;
  const cv::MatAllocator *parent = cv::Mat::getStdAllocator();
  cv::UMatData *allocate(int dims, const int *sizes, int type, void *data,
                        size_t *step, cv::AccessFlag flags, cv::UMatUsageFlags usage) const override {
    cv::UMatData *value = parent->allocate(dims, sizes, type, data, step, flags, usage);
    assert(value);
    value->currAllocator = this;
    allocated++;
    return value;
  }
  bool allocate(cv::UMatData *data, cv::AccessFlag flags, cv::UMatUsageFlags usage) const override {
    return parent->allocate(data, flags, usage);
  }
  void deallocate(cv::UMatData *data) const override {
    assert(data && data->currAllocator == this);
    data->currAllocator = parent;
    freed++;
    parent->deallocate(data);
  }
};
static int error_callback(int status, const char *function, const char *message,
                          const char *file, int line, void *userdata) {
  assert(status < 0 && function && message && *message && file && line > 0);
  ++*static_cast<int *>(userdata);
  return 0;
}
static void legacy_c_api(void) {
  IplImage *input = cvCreateImage(cvSize(7, 7), IPL_DEPTH_8U, 1);
  IplImage *output = cvCreateImage(cvSize(7, 7), IPL_DEPTH_8U, 1);
  assert(input && output);
  cvSetZero(input);
  input->imageData[3 * input->widthStep + 3] = static_cast<char>(255);
  cvDilate(input, output, nullptr, 1);
  for (int y = 0; y < 7; y++) {
    for (int x = 0; x < 7; x++) {
      unsigned char value = static_cast<unsigned char>(output->imageData[y * output->widthStep + x]);
      assert(value == ((x >= 2 && x <= 4 && y >= 2 && y <= 4) ? 255 : 0));
    }
  }
  cvReleaseImage(&input);
  cvReleaseImage(&output);
  assert(!input && !output);
}
int main(void) {
  legacy_c_api();
  TrackedAllocator owner;
  {
    cv::Mat input;
    input.allocator = &owner;
    input.create(7, 7, CV_8UC1);
    input.setTo(cv::Scalar(0));
    input.at<unsigned char>(3, 3) = 255;
    cv::Mat copied = input.clone();
    cv::Mat retained = input(cv::Rect(1, 1, 5, 5));
    input.release();
    assert(owner.allocated == 1 && owner.freed == 0);
    retained.at<unsigned char>(2, 2) = 200;
    assert(copied.at<unsigned char>(3, 3) == 255);
    cv::Mat dilated;
    cv::dilate(retained, dilated, cv::Mat());
    for (int y = 0; y < 5; y++) {
      for (int x = 0; x < 5; x++) {
        assert(dilated.at<unsigned char>(y, x) == ((x >= 1 && x <= 3 && y >= 1 && y <= 3) ? 200 : 0));
      }
    }
    int callback_count = 0;
    void *previous_data = nullptr;
    cv::ErrorCallback previous = cv::redirectError(error_callback, &callback_count, &previous_data);
    bool caught = false;
    try {
      cv::Mat invalid;
      cv::resize(retained, invalid, cv::Size(0, 0), 0, 0, cv::INTER_NEAREST);
    } catch (const cv::Exception &error) {
      caught = true;
      assert(error.code < 0 && !error.err.empty());
      const std::exception *base = &error;
      assert(dynamic_cast<const cv::Exception *>(base) == &error);
    }
    cv::redirectError(previous, previous_data);
    assert(caught && callback_count == 1);
    retained.release();
    assert(owner.freed == 1);
  }
  assert(owner.allocated == owner.freed);
  puts("OpenCV: legacy C morphology, external C++ allocator/ROI/clone lifetimes, exact pixels and typed exceptions/error callbacks passed");
  return 0;
}
