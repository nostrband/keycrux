#!/bin/sh
# bash doesn't exist in alpine docker linux

set -e

echo "rng_current:"
RNG=`cat /sys/devices/virtual/misc/hw_random/rng_current`
echo $RNG
if [ "$RNG" != "nsm-hwrng" ]; then
  echo "Bad random number generator"
  exit -1
fi

# no ip address is assigned to lo interface by default
ifconfig lo 127.0.0.1

cd /keycrux

# set supervisord password to make sure containers
# can't talk to it FIXME switch to unix socket
PWD=`head /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 12`
sed -i "s/{PASSWORD}/${PWD}/g" supervisord.conf

pwd
ls -l

# check
cat supervisord.conf

# launch supervisord
./supervisord -c supervisord.conf &
SUPERVISOR_PID=$!
sleep 1
echo "status"
ls -l ./supervisord-ctl.sh

/keycrux/supervisord-ctl.sh status

# services
./supervisord-ctl.sh start socat
./supervisord-ctl.sh start socat-parent
./supervisord-ctl.sh start keycrux

echo "all started"
wait $SUPERVISOR_PID
