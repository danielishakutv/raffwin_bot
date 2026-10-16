#!/usr/bin/env bash
# Stage A on the server: users, folders, databases and env files for raffwintest and raffwin.
# Needs TEST_HOST and LIVE_HOST, e.g.  TEST_HOST=test.example.com LIVE_HOST=play.example.com bash server-provision.sh
# Additive and idempotent: never overwrites or removes anything that already exists.
set -euo pipefail
: "${TEST_HOST:?set TEST_HOST (the test hostname)}" "${LIVE_HOST:?set LIVE_HOST (the live hostname)}"

gen() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-"$1"; }

setup_env() {
  local env="$1" port="$2" node_env="$3" bot_user="$4" url="$5"
  echo "== $env"
  id "$env" >/dev/null 2>&1 || useradd --system --home-dir "/srv/$env" --shell /usr/sbin/nologin --user-group "$env"
  install -d -o "$env" -g "$env" -m 750 "/srv/$env" "/srv/$env/releases" "/srv/$env/shared" "/srv/$env/backups"

  # Database: role and database named after the environment, password generated here
  if sudo -u postgres -H psql -XAtc "select 1 from pg_roles where rolname='$env'" | grep -q 1; then
    echo "   role $env exists: leaving it and its password alone"
    local dbpass_known=0
  else
    local dbpass; dbpass="$(gen 40)"
    sudo -u postgres -H psql -X -v ON_ERROR_STOP=1 -q -c "create role $env login password '$dbpass'"
    local dbpass_known=1
  fi
  if ! sudo -u postgres -H psql -XAtc "select 1 from pg_database where datname='$env'" | grep -q 1; then
    sudo -u postgres -H psql -X -v ON_ERROR_STOP=1 -q -c "create database $env owner $env"
    sudo -u postgres -H psql -X -v ON_ERROR_STOP=1 -q -d "$env" -c "revoke all on database $env from public"
  fi

  local envfile="/srv/$env/shared/.env"
  if [ -e "$envfile" ]; then
    echo "   $envfile exists: not touching it"
    return
  fi
  if [ "$dbpass_known" != 1 ]; then
    echo "   !! role existed but no env file: cannot recover its password; stopping for $env"
    return 1
  fi
  umask 077
  cat > "$envfile" <<ENV
# Raffle Win $env - generated $(date -Is) on $(hostname). Mode 600, owner $env.
NODE_ENV=$node_env
PORT=$port
HOST=127.0.0.1
DATABASE_URL=postgres://$env:$dbpass@127.0.0.1:5432/$env
BOT_TOKEN=REPLACE_WITH_THE_${bot_user^^}_TOKEN
BOT_USERNAME=$bot_user
PUBLIC_APP_URL=$url
TELEGRAM_WEBHOOK_SECRET=$(gen 48)
JWT_SECRET=$(gen 64)
IP_HASH_SALT=$(gen 32)
CORS_ORIGINS=${url%/}
TRUST_PROXY=loopback
LOG_LEVEL=info
INITDATA_MAX_AGE_SECONDS=3600
ADMIN_SESSION_HOURS=8
ADMIN_IDLE_MINUTES=30
ADMIN_SUPER_IDLE_MINUTES=120
ADMIN_BOT_COMMAND=desk$(openssl rand -hex 3)
ENV
  chown "$env:$env" "$envfile"
  chmod 600 "$envfile"
  echo "   wrote $envfile (secrets generated; BOT_TOKEN still a placeholder)"
}

setup_env raffwintest 3110 staging raffwin_test_bot "https://$TEST_HOST/"
setup_env raffwin     3120 production raffwin_bot   "https://$LIVE_HOST/"

echo "== check"
for env in raffwintest raffwin; do
  printf '%s: user=%s db=%s env=%s mode=%s\n' "$env" \
    "$(id -un "$env")" \
    "$(sudo -u postgres -H psql -XAtc "select datname from pg_database where datname='$env'")" \
    "$(test -f /srv/$env/shared/.env && echo yes || echo no)" \
    "$(stat -c '%a %U' /srv/$env/shared/.env)"
done
