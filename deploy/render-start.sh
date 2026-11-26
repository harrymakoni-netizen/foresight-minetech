#!/bin/sh
# Render service: simulation engines (HTTP on $PORT) + messaging service
# (scheduler, outbox, gateway health). If either stops, the container exits
# and Render restarts it, so neither can die silently.
set -eu
export FORESIGHT_SIMULATOR_HOST=0.0.0.0
export FORESIGHT_SIMULATOR_PORT="${PORT:-8100}"
export FORESIGHT_JOB_DATABASE="${FORESIGHT_JOB_DATABASE:-/tmp/simulator-jobs.sqlite}"
python -m services.simulator.server &
SIM=$!
FORESIGHT_PROCESS=messaging-service node --experimental-strip-types services/messaging/service.ts &
MSG=$!
trap 'kill $SIM $MSG 2>/dev/null' INT TERM
# Exit as soon as either process ends (POSIX sh has no wait -n).
while kill -0 $SIM 2>/dev/null && kill -0 $MSG 2>/dev/null; do sleep 5; done
echo "A Foresight process stopped; exiting so Render restarts the service." >&2
kill $SIM $MSG 2>/dev/null || true
exit 1
