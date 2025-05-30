if [ $(id -u) -ne 0 ]
  then echo Please run this script as root or using sudo!
  exit
fi

# run enclaves with --enclave-cid 16
ENCLAVE_CID=16

# Run supervisor
cat supervisord.conf

# shutdown first
./build/supervisord ctl -c supervisord-parent.conf status
./build/supervisord ctl -c supervisord-parent.conf shutdown

# relaunch
./build/supervisord -c supervisord-parent.conf &
SUPERVISOR_PID=$!
sleep 1
echo "status"
./build/supervisord ctl -c supervisord-parent.conf status

# main socat proxy
./build/supervisord ctl -c supervisord-parent.conf start socat

# start parent
./build/supervisord ctl -c supervisord-parent.conf start parent
./build/supervisord ctl -c supervisord-parent.conf start socat-parent

wait $SUPERVISOR_PID