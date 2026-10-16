# Raffle Win: server runbook

Raffle Win is a Telegram Mini App and its API. It is reached only through its bots:
`@raffwin_bot` (live, on `<live-host>`) and `@raffwin_test_bot` (test, on `<test-host>`).
One Linux server runs both, behind Cloudflare.

## What runs where

| | live | test |
|---|---|---|
| Linux user | `raffwin` | `raffwintest` |
| Releases | `/srv/raffwin/releases/raffwin-<sha>`, `current` symlink | `/srv/raffwintest/releases/...` |
| Env file (secrets, mode 600) | `/srv/raffwin/shared/.env` | `/srv/raffwintest/shared/.env` |
| API | `raffwin-api.service`, 127.0.0.1:3120 | `raffwintest-api.service`, 127.0.0.1:3110 |
| Database | PostgreSQL 14 database and role `raffwin` | database and role `raffwintest` |
| Web server | Apache vhost `sites-available/<live-host>.conf` | `sites-available/<test-host>.conf` |
| TLS | Let's Encrypt (webroot `/var/www/acme-challenge`); a deploy hook reloads Apache on renewal | same |
| Backups | `/srv/raffwin/backups/*.dump`, nightly 02:40 (`/etc/cron.d/raffwin-backup`) | `/srv/raffwintest/backups` |
| Admin secrets | `/root/raffwin-secrets/raffwin.txt` (root only) | `/root/raffwin-secrets/raffwintest.txt` |

Apache serves the built Mini App from `current/web` and proxies `/api/*` to the API:
`/api/v1/*` (player API), `/api/admin/v1/*` (admin API), `/api/telegram/webhook` (the bot).

## Is it up?

    curl -s https://<test-host>/api/health     # {"ok":true,"db":"up","env":"staging","commit":"..."}
    curl -s https://<live-host>/api/health     # "env":"production"
    systemctl status raffwintest-api raffwin-api
    journalctl -u raffwin-api -n 50 -o cat

## First install

    TEST_HOST=<test-host> LIVE_HOST=<live-host> bash infra/scripts/server-provision.sh
    # put each bot token into /srv/<env>/shared/.env (BOT_TOKEN=...)
    # upload a release (see "Deploying"), then:
    TEST_HOST=... LIVE_HOST=... ADMIN_USERNAME=owner ADMIN_NAME="Owner Name" ADMIN_TELEGRAM=<telegram username> \
      bash infra/scripts/server-web-and-services.sh <sha>
    certbot certonly --webroot -w /var/www/acme-challenge -d <host>     # once DNS points at the server,
    # then point SSLCertificateFile/KeyFile in the vhost at /etc/letsencrypt/live/<host>/ and reload Apache
    cd /srv/<env>/current/api && sudo -u <env> node --env-file=/srv/<env>/shared/.env dist/setup-bot.js

In @BotFather, for each bot: Bot Settings > Configure Mini App > enable the Main Mini App with
the host's URL, so invite links `https://t.me/<bot>?startapp=ref_<code>` open the app directly.

## Admin

There is no admin website. An admin opens the app from the bot, goes to Profile > Admin >
Start admin sign-in (or sends the hidden command from the secrets file). The bot then asks
for the master password, the admin username and the admin password. It deletes each message
as soon as it reads it, and answers with a one-time "Open admin" button (5 minutes, one use).
The Telegram account is bound on the first sign-in. Admin > Settings > My password changes
your own password. Admin > Admins (super admins) adds, resets and disables admins. Every admin
request is in the hash-chained `audit_log` (Admin > Audit > Verify).

Change the master password: `pnpm --filter @raffwin/api admin:master-hash` (or
`node dist/master-hash.js`), put the printed line into the env file, restart the API.

## Deploying a new version

Build `apps/api` (tsup) and `apps/miniapp` (`build:staging` for test, `build` for live). Copy
the API's `dist`, `drizzle` and a runtime-only `package.json` plus the web `dist` into a
release folder, upload it to `/srv/<env>/releases/<env>-<sha>`, then:

    bash infra/scripts/release-install.sh <env> <env>-<sha>     # npm install, migrate, switch current
    bash infra/scripts/release-activate.sh <env> <sha> <port>   # permissions, commit label, restart, health

Rollback: point `current` back at the previous release folder and restart the service.
Migrations only ever add; a rollback leaves the newer tables unused.

## Restore a backup

    systemctl stop <env>-api
    sudo -u postgres pg_dump --format=custom <env> > /srv/<env>/backups/before-restore.dump
    sudo -u postgres pg_restore --clean --if-exists -d <env> /srv/<env>/backups/<file>.dump
    systemctl start <env>-api

Backups are local to the server. Copy them to a second location as well.

## If it is down

1. `systemctl status <env>-api`. Crashed? Check `journalctl -u <env>-api -n 100`.
2. A config error names the bad variable when the API starts (`Invalid API environment: ...`).
3. `curl -s http://127.0.0.1:<port>/health`: `"db":"down"` means PostgreSQL.
4. Through Apache: `curl -sk --resolve <host>:443:127.0.0.1 https://<host>/api/health`.
5. From outside: `curl -s https://<host>/api/health`.
