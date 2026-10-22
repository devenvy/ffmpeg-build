FROM mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0
RUN apt-get update && apt-get install -y --no-install-recommends pocl-opencl-icd binutils && rm -rf /var/lib/apt/lists/*
