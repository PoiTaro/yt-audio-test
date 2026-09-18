#!/bin/sh
set -eu

node /app/src/internal-gateway.js &
gateway_pid=$!

gunicorn --chdir /app/mr-backend \
  --bind "0.0.0.0:${PORT:-10000}" \
  --workers 1 \
  --threads 4 \
  --timeout 900 \
  --access-logfile - \
  --error-logfile - \
  app:app &
gunicorn_pid=$!

shutdown() {
  kill -TERM "$gunicorn_pid" "$gateway_pid" 2>/dev/null || true
}

trap shutdown INT TERM EXIT
wait "$gunicorn_pid"
status=$?
kill -TERM "$gateway_pid" 2>/dev/null || true
wait "$gateway_pid" 2>/dev/null || true
exit "$status"
