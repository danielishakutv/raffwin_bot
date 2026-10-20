#!/usr/bin/env bash
# Stage C on the server: permissions, systemd units, Apache vhosts (temporary self-signed
# TLS until DNS points here), master passwords, first admin, nightly backups.
# Needs TEST_HOST, LIVE_HOST and the first admin: ADMIN_USERNAME, ADMIN_NAME, ADMIN_TELEGRAM
# (their Telegram username, or first-signin).
# Additive: new files only; every existing file it would replace is refused instead.
# Usage: bash -s -- <git-sha>
set -euo pipefail
: "${TEST_HOST:?}" "${LIVE_HOST:?}" "${ADMIN_USERNAME:?}" "${ADMIN_NAME:?}" "${ADMIN_TELEGRAM:?}"
SHA="$1"
STAMP=$(date +%F-%H%M)
SECRETS=/root/raffwin-secrets
install -d -m 700 "$SECRETS"
newfile() { if [ -e "$1" ]; then echo "   exists, not replacing: $1"; return 1; fi; return 0; }

declare -A PORT=([raffwintest]=3110 [raffwin]=3120)
declare -A HOSTN=([raffwintest]=$TEST_HOST [raffwin]=$LIVE_HOST)

for env in raffwintest raffwin; do
  host=${HOSTN[$env]}; port=${PORT[$env]}
  echo "######## $env ($host -> 127.0.0.1:$port)"

  # 1. Apache may read the built web files and nothing else
  chmod 751 "/srv/$env" "/srv/$env/releases" "$(readlink -f /srv/$env/current)"
  chmod -R a+rX "$(readlink -f /srv/$env/current)/web"
  chmod 750 "$(readlink -f /srv/$env/current)/api" "/srv/$env/shared" "/srv/$env/backups"

  # 2. systemd unit (sandboxed; loopback only; the env file is the only secret it reads)
  unit=/etc/systemd/system/$env-api.service
  if newfile "$unit"; then
    cat > "$unit" <<UNIT
[Unit]
Description=Raffle Win API ($env) on 127.0.0.1:$port
After=network-online.target postgresql.service
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
User=$env
Group=$env
WorkingDirectory=/srv/$env/current/api
Environment=GIT_COMMIT=$SHA
Environment=MIGRATIONS_DIR=/srv/$env/current/api/drizzle
ExecStart=/usr/bin/node --env-file=/srv/$env/shared/.env dist/server.js
Restart=always
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadOnlyPaths=/srv/$env
# The super admin data reset and player delete save a pg_dump here first (RESET_BACKUP_DIR)
ReadWritePaths=/srv/$env/backups
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
    echo "   wrote $unit"
  fi

  # 3. Temporary self-signed origin certificate (replaced by Let's Encrypt once DNS points here)
  install -d -m 755 /etc/ssl/raffwin
  if newfile "/etc/ssl/raffwin/$host.crt"; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$host" \
      -keyout "/etc/ssl/raffwin/$host.key" -out "/etc/ssl/raffwin/$host.crt" 2>/dev/null
    chmod 600 "/etc/ssl/raffwin/$host.key"
    echo "   self-signed cert for $host (30 days, temporary)"
  fi

  # 4. Apache vhost: static app + /api proxy, same host, Cloudflare real IPs
  vhost=/etc/apache2/sites-available/$host.conf
  if newfile "$vhost"; then
    common="    ServerName $host
    Include /etc/apache2/snippets/cloudflare-realip.conf
    DocumentRoot /srv/$env/current/web
    ErrorLog  \${APACHE_LOG_DIR}/$host-error.log
    CustomLog \${APACHE_LOG_DIR}/$host-access.log combined

    # Let's Encrypt HTTP-01 (shared challenge folder)
    ProxyPass /.well-known/acme-challenge/ !
    Alias /.well-known/acme-challenge/ /var/www/acme-challenge/.well-known/acme-challenge/
    <Directory /var/www/acme-challenge/.well-known/acme-challenge/>
        Require all granted
    </Directory>

    <Directory /srv/$env>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>

    # The API on the same host: /api/* -> 127.0.0.1:$port/* (bot webhook, player and admin API)
    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader set X-Forwarded-Proto \"https\"
    ProxyPass        /api/ http://127.0.0.1:$port/ retry=0 timeout=30
    ProxyPassReverse /api/ http://127.0.0.1:$port/
    <Location /api/>
        Header always set Cache-Control \"no-store\"
        Header always set CDN-Cache-Control \"no-store\"
    </Location>

    # The app shell must never be cached; hashed assets forever
    <Files index.html>
        Header set Cache-Control \"no-cache\"
    </Files>
    <LocationMatch \"^/assets/\">
        Header set Cache-Control \"public, max-age=31536000, immutable\"
    </LocationMatch>
    # No X-Frame-Options: Telegram Web opens Mini Apps inside an iframe
    Header always set X-Content-Type-Options \"nosniff\"
    Header always set Referrer-Policy \"strict-origin-when-cross-origin\""
    cat > "$vhost" <<VHOST
# Raffle Win ($env). Generated $STAMP. Reached only through Telegram (@${env/raffwintest/raffwin_test}_bot).
<VirtualHost *:80>
$common
</VirtualHost>

<VirtualHost *:443>
$common
    SSLEngine on
    SSLCertificateFile    /etc/ssl/raffwin/$host.crt
    SSLCertificateKeyFile /etc/ssl/raffwin/$host.key
</VirtualHost>
VHOST
    echo "   wrote $vhost"
  fi
done

# Apache: enable, test, graceful reload (other sites keep serving)
a2ensite -q "$TEST_HOST.conf" "$LIVE_HOST.conf"
if ! apache2ctl configtest; then
  # Never leave a broken config enabled: the next reload by anyone would take every site down
  a2dissite -q "$TEST_HOST.conf" "$LIVE_HOST.conf"
  echo "   !! configtest failed; the two new sites were disabled again; nothing reloaded"
  exit 1
fi
systemctl reload apache2
echo "   apache reloaded: $(systemctl is-active apache2)"

# 5. Master passwords and the first admin, per environment
for env in raffwintest raffwin; do
  rel=$(readlink -f /srv/$env/current)
  f="$SECRETS/$env.txt"
  if [ -e "$f" ]; then echo "   $f exists: master password and admin already made for $env"; continue; fi
  master=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-28)
  hash=$(cd "$rel/api" && MP="$master" node --input-type=module -e "import { hash } from '@node-rs/argon2'; process.stdout.write(await hash(process.env.MP))")
  case "$hash" in '$argon2id$'*) ;; *) echo "   !! hashing failed for $env"; exit 1;; esac
  grep -q '^ADMIN_MASTER_PASSWORD_HASH=' "/srv/$env/shared/.env" || printf "ADMIN_MASTER_PASSWORD_HASH='%s'\n" "$hash" >> "/srv/$env/shared/.env"
  cmd=$(sed -n 's/^ADMIN_BOT_COMMAND=//p' "/srv/$env/shared/.env")
  token_ok=1; grep -q '^BOT_TOKEN=REPLACE_WITH' "/srv/$env/shared/.env" && token_ok=0
  out=$(cd "$rel/api" && sudo -u "$env" -H env BOT_TOKEN_OVERRIDE= \
        bash -c "$( [ $token_ok = 1 ] && echo '' || echo 'export BOT_TOKEN=1:placeholder-token-for-admin-create-only-0000;' ) node --env-file=/srv/$env/shared/.env dist/create-admin.js --username '$ADMIN_USERNAME' --name '$ADMIN_NAME' --telegram '$ADMIN_TELEGRAM' --role super_admin" 2>&1)
  umask 077
  {
    echo "Raffle Win $env - admin secrets, made $STAMP on $(hostname). Root only. Read, store in your password manager, then move this file out of the way."
    echo
    echo "Bot:                 @$( [ $env = raffwintest ] && echo raffwin_test_bot || echo raffwin_bot )"
    echo "Hidden admin command: /$cmd"
    echo "Master password:     $master"
    echo
    echo "$out"
  } > "$f"
  chmod 600 "$f"
  echo "   $env: master password + admin '$ADMIN_USERNAME' made; details in $f"
done

# 6. Nightly database backups (custom-format pg_dump, kept; nothing is pruned)
if newfile /usr/local/sbin/raffwin-backup.sh; then
  cat > /usr/local/sbin/raffwin-backup.sh <<'BK'
#!/usr/bin/env bash
# Nightly pg_dump of the Raffle Win databases into /srv/<env>/backups. Never deletes.
set -uo pipefail
status=0
for env in raffwintest raffwin; do
  out="/srv/$env/backups/$env-$(date +%F-%H%M).dump"
  if sudo -u postgres pg_dump --format=custom --no-owner "$env" > "$out.part" 2>/tmp/raffwin-backup-$env.err && [ -s "$out.part" ]; then
    mv "$out.part" "$out"; chown "$env:$env" "$out"; chmod 640 "$out"
    echo "$(date -Is) $env ok $(stat -c %s "$out") bytes -> $out"
  else
    echo "$(date -Is) $env FAILED: $(cat /tmp/raffwin-backup-$env.err)"; status=1
  fi
done
exit $status
BK
  chmod 750 /usr/local/sbin/raffwin-backup.sh
fi
if newfile /etc/cron.d/raffwin-backup; then
  printf 'MAILTO=root\nSHELL=/bin/bash\n40 2 * * * root /usr/local/sbin/raffwin-backup.sh >> /var/log/raffwin-backup.log 2>&1 || echo "Raffle Win backup FAILED - see /var/log/raffwin-backup.log"\n' > /etc/cron.d/raffwin-backup
fi
/usr/local/sbin/raffwin-backup.sh | tee -a /var/log/raffwin-backup.log

# 7. Start the test API (its token is set); the live one waits for the @raffwin_bot token
systemctl daemon-reload
for env in raffwintest raffwin; do
  if grep -q '^BOT_TOKEN=REPLACE_WITH' "/srv/$env/shared/.env"; then
    echo "   $env-api: NOT started (BOT_TOKEN placeholder). Unit installed, not enabled."
  else
    systemctl enable --now "$env-api.service"
    sleep 2
    echo "   $env-api: $(systemctl is-active $env-api.service)"
  fi
done
