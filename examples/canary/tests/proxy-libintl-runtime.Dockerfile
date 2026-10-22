FROM mirror.gcr.io/library/node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d
RUN apk add --no-cache binutils libgcc
