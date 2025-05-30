#!/bin/bash

runuser -l ec2-user -- -c "cd /home/ec2-user/keycrux; ./node_modules/.bin/tsx src/index.ts parent run" 

