#!/usr/bin/env bash
# After stage B switched /srv/$env/current to a new release: open the web files to
# Apache, label the service with the commit, restart it if it runs, check health.
# Usage: bash -s -- <env> <git-sha> <port>
set -euo pipefail
env="$1"; sha="$2"; port="$3"
rel=$(readlink -f "/srv/$env/current")
chmod 751 "$rel"
chmod -R a+rX "$rel/web"
chmod 750 "$rel/api"
unit=/etc/systemd/system/$env-api.service
cp -p "$unit" "$unit.bak.$(date +%F-%H%M%S)"
sed -i "s/^Environment=GIT_COMMIT=.*/Environment=GIT_COMMIT=$sha/" "$unit"
systemctl daemon-reload
if systemctl is-enabled --quiet "$env-api.service"; then
  systemctl restart "$env-api.service"
  for i in $(seq 1 20); do
    if curl -sf -m2 "http://127.0.0.1:$port/health" >/dev/null; then break; fi
    sleep 0.5
  done
  echo "$env: $(curl -s -m3 http://127.0.0.1:$port/health)"
else
  echo "$env: service not enabled (waiting for its bot token); web files updated"
fi
