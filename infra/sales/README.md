# Sales site: server runbook

The sales site (apps/buy-api, apps/buy-web) runs on its own server, apart from the game:
a shared box with mail and other sites, behind Cloudflare. Everything here is additive;
nothing is ever deleted (old releases, backups and `.bak` files stay).

| | Live | Test |
|---|---|---|
| Site | `https://<sales-host>/` | `https://<sales-test-host>/` |
| Service | `instaplay-api` on 127.0.0.1:3420 | `instaplaytest-api` on 127.0.0.1:3421 |
| Files | `/srv/instaplay/{releases,current,shared,backups}` | `/srv/instaplaytest/...` |
| Env (root, 600) | `/srv/instaplay/shared/api.env` | `/srv/instaplaytest/shared/api.env` |
| Paystack | `sk_live_` | `sk_test_` |
| Talks to | the live game's API | the test game's API |

- **Database:** one container `instaplay-db` (Postgres 16, `127.0.0.1:5435`, 384 MB cap) from
  `/srv/instaplay-db/docker-compose.yml`, databases `instaplay` and `instaplaytest`, each with its
  own role. Passwords in `/srv/instaplay-db/.env` (root, 600), generated on the box.
- **TLS:** a Cloudflare Origin certificate for the zone, `/etc/ssl/cloudflare/instaplay.ng.{pem,key}`;
  Cloudflare SSL mode Full (strict).
- **Secrets as files:** `/root/instaplay-secrets/` (root, 700): login bot tokens, Paystack keys,
  relay secrets (`relay-live.txt`, `relay-test.txt`, copied from the game server's
  `/root/raffwin-secrets/`). Never on a command line, never in chat.
- **Backups:** `/usr/local/sbin/instaplay-backup.sh` from `/etc/cron.d/instaplay-backup` at 02:50,
  one dump per database per day into `/srv/<db>/backups`. Failures alert through
  `toko-telegram-notify`.
- **Watchdog:** both `/api/health` URLs are in `CHECK_URLS` of `/etc/server-watchdog.conf`.

## Releasing a new version

Built on a workstation, never on the box (it runs mail and other sites):

```sh
pnpm --filter @instaplay/buy-api build            # also runs the separation check
cd apps/buy-web && npx vite build --mode staging --outDir <root>/web-instaplaytest
                   npx vite build --mode production --outDir <root>/web-instaplay
node infra/sales/assemble-release.mjs <repo> <root> instaplaytest <sha>   # and instaplay
tar czf instaplaytest-<sha>.tgz instaplaytest-<sha>
```

On the server, per environment (`e=instaplaytest`, then `e=instaplay`):

```sh
scp <e>-<sha>.tgz <server>:/root/          # compare sha256 on both sides
test ! -e /srv/$e/releases/$e-<sha> && tar xzf /root/$e-<sha>.tgz -C /srv/$e/releases --no-same-owner
cd /srv/$e/releases/$e-<sha>/api && npm install --omit=dev --ignore-scripts --no-audit --no-fund
/usr/local/sbin/instaplay-backup.sh        # a dump before migrating
MIGRATIONS_DIR=$PWD/drizzle node --env-file=/srv/$e/shared/api.env dist/migrate.js
ln -sfn /srv/$e/releases/$e-<sha> /srv/$e/current.new && mv -Tf /srv/$e/current.new /srv/$e/current
u=/etc/systemd/system/$e-api.service; cp -p $u $u.bak.$(date +%F-%H%M%S)
sed -i "s/^Environment=GIT_COMMIT=.*/Environment=GIT_COMMIT=<sha>/" $u
systemctl daemon-reload && systemctl restart $e-api
curl -s http://127.0.0.1:<port>/api/health  # and from outside: https://<host>/api/health
```

Rollback: point `current` at the previous release and restart (migrations are forward-only and
additive, so the previous code runs on the newer schema).

## Telegram login

The pages do not load Telegram's widget script: it calls `eval()`, which the site's
Content-Security-Policy forbids. `apps/buy-web/src/TelegramLogin.tsx` opens Telegram's login
window itself and takes the signed result from `oauth.telegram.org` (allowed in `connect-src`).
Each login bot needs its domain set in BotFather (`/setdomain`), or Telegram refuses the login.

## Paystack

Webhook URLs (set in the dashboard, separately for Test and Live mode):
`https://<sales-test-host>/api/paystack/webhook` and `https://<sales-host>/api/paystack/webhook`.
Reconciliation by hand: `node --env-file=/srv/$e/shared/api.env dist/reconcile.js [from] [to]`
from `/srv/$e/current/api`.
