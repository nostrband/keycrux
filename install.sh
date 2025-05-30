#!/bin/bash

# from https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-cli-install.html

set -e

sudo dnf install aws-nitro-enclaves-cli -y
sudo dnf install aws-nitro-enclaves-cli-devel -y
sudo dnf install socat -y
sudo dnf install docker -y
sudo usermod -aG ne ec2-user
sudo usermod -aG docker ec2-user

# leave 2 CPU for parent
ENCLAVE_CPUS=`cat /proc/cpuinfo  | grep processor | wc | awk '{print $1-2}'`
# 50% of memory to enclave, can't have more bcs it requires all memory
# to be on the same "node" 
ENCLAVE_RAM=`free | grep Mem  | awk '{print (int($2 / 1024 / 1024) + 1) / 2 * 1024}'`
cat > allocator.yaml <<EOF
---
# Enclave configuration file.
#
# How much memory to allocate for enclaves (in MiB).
memory_mib: $ENCLAVE_RAM
#
# How many CPUs to reserve for enclaves.
cpu_count: $ENCLAVE_CPUS
EOF

sudo mv allocator.yaml /etc/nitro_enclaves/allocator.yaml

sudo systemctl enable --now nitro-enclaves-allocator.service
sudo systemctl enable --now docker

# supervisord
mkdir -p build
wget https://github.com/ochinchina/supervisord/releases/download/v0.7.3/supervisord_0.7.3_Linux_64-bit.tar.gz
sha256sum ./supervisord_0.7.3_Linux_64-bit.tar.gz | grep f0308bab9c781be06ae59c4588226a5a4b7576ae7e5ea07b9dc86edc0b998de0
tar -xvzf ./supervisord_0.7.3_Linux_64-bit.tar.gz
mv ./supervisord_0.7.3_Linux_64-bit/supervisord ./build/supervisord
rm -Rf ./supervisord_0.7.3_Linux_64-bit ./supervisord_0.7.3_Linux_64-bit.tar.gz

# rclone
wget https://downloads.rclone.org/v1.69.2/rclone-v1.69.2-linux-amd64.rpm
sha256sum rclone-v1.69.2-linux-amd64.rpm | grep 13a7921b13e7e34ceef9a0ac51b98769449d3d601dee2eb9a78bd86eb7bab3f4
sudo dnf install rclone-v1.69.2-linux-amd64.rpm -y

# age (encryption)
wget https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz
sha256sum age-v1.2.1-linux-amd64.tar.gz | grep 7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
tar -xvzf age-v1.2.1-linux-amd64.tar.gz --strip-components=1 age/age
tar -xvzf age-v1.2.1-linux-amd64.tar.gz --strip-components=1 age/age-keygen
rm -Rf age-v1.2.1-linux-amd64.tar.gz

# git
sudo dnf install -y git

# node
wget https://nodejs.org/dist/v24.0.1/node-v24.0.1-linux-x64.tar.xz
sha256sum node-v24.0.1-linux-x64.tar.xz | grep 12d8b7c7dd9191bd4f3afe872c7d4908ac75d2a6ef06d2ae59c0b4aa384bc875
sudo tar -xJf node-v24.0.1-linux-x64.tar.xz -C /usr/local --strip-components=1 && rm node-v24.0.1-linux-x64.tar.xz

# nix
sh <(curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install) --daemon
