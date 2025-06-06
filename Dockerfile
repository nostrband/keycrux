# Build layer
FROM ubuntu:jammy-20240627.1@sha256:340d9b015b194dc6e2a13938944e0d016e57b9679963fdeb9ce021daac430221 AS build

# Lock environment for reproducibility
ARG SOURCE_DATE_EPOCH
ENV TZ=UTC
WORKDIR /keycrux

RUN echo "Timestamp" ${SOURCE_DATE_EPOCH}

RUN apt-get update && apt-get install -y --no-install-recommends \
  "ca-certificates=20240203~22.04.1" \
  "curl=7.81.0-1ubuntu1.20" \
  bash=5.1-6ubuntu1.1 \
  wget=1.21.2-2ubuntu1.1 \
  socat=1.7.4.1-3ubuntu4 \
  ipset=7.15-1build1 \
  xz-utils=5.2.5-2ubuntu1 \
  "net-tools=1.60+git20181103.0eebece-1ubuntu5.4"
RUN apt clean && rm -Rf /var/lib/apt/lists/* /var/log/* /tmp/* /var/tmp/* /var/cache/ldconfig/aux-cache

# supervisord
RUN wget https://github.com/ochinchina/supervisord/releases/download/v0.7.3/supervisord_0.7.3_Linux_64-bit.tar.gz
RUN sha256sum ./supervisord_0.7.3_Linux_64-bit.tar.gz | grep f0308bab9c781be06ae59c4588226a5a4b7576ae7e5ea07b9dc86edc0b998de0
RUN tar -xvzf ./supervisord_0.7.3_Linux_64-bit.tar.gz
RUN mv ./supervisord_0.7.3_Linux_64-bit/supervisord ./supervisord
RUN rm -Rf ./supervisord_0.7.3_Linux_64-bit ./supervisord_0.7.3_Linux_64-bit.tar.gz

# nodejs
RUN wget https://nodejs.org/dist/v24.0.1/node-v24.0.1-linux-x64.tar.xz
RUN sha256sum node-v24.0.1-linux-x64.tar.xz | grep 12d8b7c7dd9191bd4f3afe872c7d4908ac75d2a6ef06d2ae59c0b4aa384bc875
RUN tar -xJf node-v24.0.1-linux-x64.tar.xz -C /usr/local --strip-components=1 && rm node-v24.0.1-linux-x64.tar.xz

# Copy only package-related files first
COPY package*.json ./

# Install dependencies 
RUN npm ci --ignore-scripts
RUN rm -Rf /tmp/*

# Copy the rest of the project
COPY src/enclave src/enclave
COPY src/modules src/modules
COPY tsconfig.json ./

COPY ./enclave*.sh .
COPY ./supervisord.conf .
COPY ./supervisord-ctl.sh .
COPY ./release.json .

# Mac has different default perms vs Linux
RUN chown -R root:root *
RUN chmod -R go-w *

# remove files generated on MacOS
RUN rm -Rf /root
RUN mkdir /root

# Result layer, must be used to exclude global non-reproducible changes made
# by npm install calls - we're only copying current dir to the result
FROM ubuntu:jammy-20240627.1@sha256:340d9b015b194dc6e2a13938944e0d016e57b9679963fdeb9ce021daac430221 AS server
WORKDIR /

# copy everything
COPY --from=build / /

# Run the server
ENTRYPOINT ["/keycrux/enclave.sh"]
