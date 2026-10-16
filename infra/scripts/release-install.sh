#!/usr/bin/env bash
# Stage B on the server, run per environment after the release has been unpacked into
# /srv/$ENV/releases/$REL: install runtime deps as the service user, migrate, point current at it.
# Usage: bash -s -- <env> <release-name>
set -euo pipefail
env="$1"; rel="$2"
dir="/srv/$env/releases/$rel"
test -d "$dir/api" || { echo "missing $dir/api"; exit 1; }
chown -R "$env:$env" "$dir"

echo "== $env: npm install (runtime only)"
cd "$dir/api"
sudo -u "$env" -H env HOME="/srv/$env" npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -3
node -e "require('/srv/$env/releases/$rel/api/node_modules/@node-rs/argon2'); console.log('argon2 native binding loads')"

echo "== $env: migrate"
if grep -q '^BOT_TOKEN=REPLACE_WITH' "/srv/$env/shared/.env"; then
  # Config validation needs a token-shaped value; migrations never call Telegram
  sudo -u "$env" -H env MIGRATIONS_DIR="$dir/api/drizzle" BOT_TOKEN=1:placeholder-token-for-migrations-only-0000 \
    node --env-file="/srv/$env/shared/.env" dist/migrate.js
else
  sudo -u "$env" -H env MIGRATIONS_DIR="$dir/api/drizzle" node --env-file="/srv/$env/shared/.env" dist/migrate.js
fi

echo "== $env: current -> $rel"
ln -sfn "$dir" "/srv/$env/current.new" && mv -Tf "/srv/$env/current.new" "/srv/$env/current"
readlink "/srv/$env/current"
