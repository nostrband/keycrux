#!/bin/bash
echo "running supervisord-ctl"
PWD=`grep password= supervisord.conf | awk 'BEGIN{FS="="}{print $2}'`
./supervisord ctl -c supervisord.conf -u keycrux -P ${PWD} $@
