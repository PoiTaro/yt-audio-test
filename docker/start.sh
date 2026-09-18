#!/bin/sh
set -eu

if [ -n "${SESSION_TOKEN_URL:-}" ]; then
  echo "[session] starting Xvfb and trusted-session generator"
  Xvfb :99 -ac -screen 0 "${XVFB_WHD:-1280x720x16}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  PYTHONUNBUFFERED=1 DISPLAY=:99 /opt/yt-session-venv/bin/python \
    /opt/yt-session-generator/potoken-generator.py \
    --bind 127.0.0.1 --port 8080 2>&1 \
    | sed -u '/new token:/d; /visitor_data:/d; /po_token:/d' &
fi

exec npm start
