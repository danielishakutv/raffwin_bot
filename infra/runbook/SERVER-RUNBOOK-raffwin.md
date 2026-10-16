

# raffwin.toko.com.ng / raffwintest.toko.com.ng — Raffle Win runbook

Added 2026-10-16. Telegram Mini App + API for Raffle Win. Reached only through the
bots: @raffwin_bot (live, raffwin.toko.com.ng) and @raffwin_test_bot (test,
raffwintest.toko.com.ng). Code: github.com/danielishakutv/raffwin_bot (pnpm workspace).

## What runs where

| | live | test |
|---|---|---|
| Linux user | raffwin | raffwintest |
| Release dir | /srv/raffwin/releases/<env>-<sha>, `current` symlink | /srv/raffwintest/... |
| Env file (secrets, 600) | /srv/raffwin/shared/.env | /srv/raffwintest/shared/.env |
| API | raffwin-api.service, 127.0.0.1:3120 | raffwintest-api.service, 127.0.0.1:3110 |
| Database | Postgres 14 db + role `raffwin` | db + role `raffwintest` |
| Apache | sites-available/raffwin.toko.com.ng.conf | sites-available/raffwintest.toko.com.ng.conf |
| TLS | Let's Encrypt (webroot /var/www/acme-challenge), renew hook reloads Apache | same |
| Backups | /srv/raffwin/backups/*.dump nightly 02:40 (/etc/cron.d/raffwin-backup) | /srv/raffwintest/backups |
| Admin secrets | /root/raffwin-secrets/raffwin.txt (root, 600) | /root/raffwin-secrets/raffwintest.txt |

Apache serves the built Mini App from `current/web` and proxies `/api/*` to the API
(`/api/v1/*` player API, `/api/admin/v1/*` admin API, `/api/telegram/webhook` bot).

## Is it up?

    curl -s https://raffwintest.toko.com.ng/api/health     # {"ok":true,"db":"up",...,"commit":...}
    curl -s https://raffwin.toko.com.ng/api/health
    systemctl status raffwintest-api raffwin-api
    journalctl -u raffwintest-api -n 50 -o cat

The machine watchdog checks the test health URL (add the live one once raffwin-api runs).

## Live is not started yet (2026-10-16)

`raffwin-api.service` is installed but NOT enabled: /srv/raffwin/shared/.env still has
`BOT_TOKEN=REPLACE_WITH_THE_RAFFWIN_BOT_TOKEN`. To go live:

    sudoedit /srv/raffwin/shared/.env          # paste the @raffwin_bot token from BotFather
    systemctl enable --now raffwin-api
    curl -s http://127.0.0.1:3120/health
    cd /srv/raffwin/current/api && sudo -u raffwin node --env-file=/srv/raffwin/shared/.env dist/setup-bot.js
    # then add to server-watchdog.sh:  check_url "https://raffwin.toko.com.ng/api/health" 200 "Raffle Win live health"

## Admin

No admin website. In the bot chat: send the hidden command (in the secrets file), then the
master password, admin username and admin password; each message is deleted on read and the
bot answers with a one-time "Open admin" button. First admin: `daniel`, bound to Telegram
@tokopay. Add more admins from the admin screen (Admins tab). Every admin request is in the
hash-chained `audit_log` (Admin > Audit > Verify).

## Deploying a new version

From the repo: build `apps/api` (tsup) and `apps/miniapp` (`build:staging` for test,
`build` for live), copy dist + drizzle + a runtime package.json into a release folder,
upload to `/srv/<env>/releases/<env>-<sha>`, then as root:

    cd /srv/<env>/releases/<env>-<sha>/api
    sudo -u <env> npm install --omit=dev
    sudo -u <env> env MIGRATIONS_DIR=$PWD/drizzle node --env-file=/srv/<env>/shared/.env dist/migrate.js
    ln -sfn /srv/<env>/releases/<env>-<sha> /srv/<env>/current.new && mv -Tf /srv/<env>/current.new /srv/<env>/current
    chmod 751 "$(readlink -f /srv/<env>/current)"; chmod -R a+rX /srv/<env>/current/web
    sed -i "s/^Environment=GIT_COMMIT=.*/Environment=GIT_COMMIT=<sha>/" /etc/systemd/system/<env>-api.service
    systemctl daemon-reload && systemctl restart <env>-api

Rollback: point `current` at the previous release dir and restart. Migrations are forward-only.

## Restore a backup

    sudo -u postgres pg_restore --clean --if-exists -d <env> /srv/<env>/backups/<file>.dump

(stop <env>-api first; `--clean` replaces the current data, so take a fresh dump before.)
Backups are local only for now: offsite copies are on the open list for this server.

## If it is down

1. `systemctl status <env>-api` — crashed? `journalctl -u <env>-api -n 100`.
2. Config errors name the bad variable on start (`Invalid API environment: ...`).
3. `curl -s http://127.0.0.1:<port>/health` — `db:"down"` means Postgres.
4. Through Apache: `curl -sk --resolve <host>:443:127.0.0.1 https://<host>/api/health`.
5. From outside: `curl -s https://<host>/api/health` (Cloudflare in front).
