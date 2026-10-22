FROM mirror.gcr.io/library/rabbitmq@sha256:0791924edc1fcf394e6ce80f735446e2efdb3cd2ea16d986127308981d68760b
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update -qq \
 && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y -qq --no-install-recommends python3 libzmq5 binutils \
 && rm -rf /var/lib/apt/lists/*
