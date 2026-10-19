# Raffle Win

A raffle platform that lives entirely inside Telegram. Players open it from the bot, enter
raffles for phones, laptops and more with Raffs (the in-app credit), invite friends for 10%
of their entries, and give delivery details only when they win. There is no website, sign-up
form or password for players: opening the bot is the account.

| | Live | Test |
|---|---|---|
| Bot | `@raffwin_bot` | `@raffwin_test_bot` |
| App and API | `https://<live-host>/` (API under `/api`) | `https://<test-host>/` |
| Build mode | `production` | `staging` (shows a STAGING badge) |

## Repository

```
apps/
  miniapp/    Telegram Mini App (React 19, Vite, Tailwind, Zustand). Player screens and the admin screen.
  api/        API (Express 5, Drizzle ORM, PostgreSQL 14+), Telegram bot webhook (grammY), CLIs.
  buy-api/    Sales site backend: Telegram login, Paystack checkout and webhook, credit outbox (own database).
  buy-web/    Sales site pages (React 19, Vite, Tailwind). Talks only to buy-api, on its own domain.
packages/
  shared/     Types, validation, request schemas, rate and referral rules used by the game (not the sales site).
  relay/      The signed contract between buy-api and the API: signing, checks, request shapes.
scripts/
  check-separation.mjs   Fails a build if the sales site names the game or the game names the sales site.
infra/
  scripts/    Server provisioning and release scripts (additive; they never delete).
  runbook/    Server runbook: what runs where, deploy, restore, troubleshooting.
docs/
  ARCHITECTURE.md   How it works and why.
bot/          Earlier standalone bot, superseded by the webhook inside apps/api. Kept for reference.
```

## Run it locally

Needs Node 22, pnpm 10 and PostgreSQL (14 or newer).

```sh
pnpm install

# database: a role and two databases, once
psql -h localhost -U postgres -c "CREATE ROLE raffwin LOGIN PASSWORD 'choose-one';" \
  -c "CREATE DATABASE raffwin_dev OWNER raffwin;" -c "CREATE DATABASE raffwin_test OWNER raffwin;"

cp apps/api/.env.example apps/api/.env      # fill in DATABASE_URL, TEST_DATABASE_URL, BOT_TOKEN, JWT_SECRET, IP_HASH_SALT
pnpm db:migrate
pnpm --filter @raffwin/api dev:seed         # three sample raffles (development only)
pnpm dev:api                                # API on http://127.0.0.1:3100

pnpm dev                                    # Mini App on http://localhost:5173 (in-browser demo data)
VITE_API_URL=http://localhost:3100 pnpm dev # Mini App against the local API
```

Outside Telegram the Mini App shows "Open in Telegram" unless `VITE_ALLOW_BROWSER=true`
(development only; production builds refuse it). Without `VITE_API_URL` it uses the built-in
demo data, so the screens can be worked on with no backend.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test        # API tests run against real PostgreSQL (TEST_DATABASE_URL), a fresh schema per run
pnpm build
```

CI runs the same steps on every push, against PostgreSQL 14.

## Configuration

API settings live in `apps/api/.env`, documented line by line in
`apps/api/.env.example`. The essentials:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `BOT_TOKEN`, `BOT_USERNAME` | The bot that opens this deployment (Telegram signs every launch with it) |
| `PUBLIC_APP_URL`, `TELEGRAM_WEBHOOK_SECRET` | Where the app lives; the webhook secret Telegram sends back |
| `JWT_SECRET`, `IP_HASH_SALT` | Session signing key; salt for hashing IP addresses (never stored raw) |
| `ADMIN_MASTER_PASSWORD_HASH`, `ADMIN_BOT_COMMAND` | Admin sign-in (see below) |

Mini App build settings are in `apps/miniapp/.env.*` (no secrets there; they ship in the bundle).

## How players use it

- **Account:** created on the first open from the player's Telegram account. Their username
  and name come from Telegram.
- **Raffs:** each raffle has a fixed entry price in Raffs. Nothing is sold inside the Mini App
  (no prices, no payment links): players get Raffs on the separate sales site (below), from
  voucher codes (Wallet > Redeem a code), as prizes, from referrals and bonuses.
- **Entries:** one database transaction locks the raffle, assigns contiguous ticket numbers
  and moves the balance. A retried tap never makes a second entry, and a raffle can never
  sell more entries than it has.
- **Referrals:** a referrer earns 10% of every entry their friends make, in Raffs, single level.
- **Prize delivery (KYC):** only when needed. The player gives their name, their phone
  (shared from Telegram, so it is verified), their state and city, and the nearest motor
  park. Prizes go to that motor park, never to a home address.
- **Live updates:** entry counts, balance and raffle states refresh every few seconds while
  the app is open, with no reload needed.

## Admin

There is no admin website. An admin signs in inside Telegram:

1. Open the app from the bot, then Profile > Admin > **Start admin sign-in** (or send the
   hidden admin command to the bot).
2. The bot asks for the master password, the admin username and the admin password. It
   deletes each message as soon as it has read it.
3. It answers with an **Open admin** button that works once, within 5 minutes. The first
   sign-in binds that Telegram account to the admin; afterwards the admin works only from it.

The admin screen covers the overview, raffles (create, open, ask to cancel), approvals,
players (search, suspend, ask to adjust a balance), vouchers, settings (rate and sales, limits,
your own password), security events, the audit log with a tamper check, and admins (add,
reset, disable). Anything that moves money or changes the rate needs a second admin's approval.
Every admin request is recorded in the audit log.

- **Rate and sales** (Settings): the base price of one Raff in naira, the hourly movement range
  (3% to 15% by default; 0 and 0 is a fixed price), the packages and their bonus (at most 15%),
  and the smallest and largest purchase. The sales site reads all of these through the relay.
- **Vouchers:** ask for a batch (vendor, Raffs per code, how many, optional expiry); once a second
  admin approves, issue the codes. They are shown **once**, to download or copy for the vendor:
  only their SHA-256 is stored. Look a code up to see who used it; void a code or a batch.

Create the first admin on the server with
`node --env-file=.env dist/create-admin.js --username <name> --name "<full name>" --telegram <telegram username> --role super_admin`.
It prints the password once.

## Deploying

See `infra/runbook/SERVER-RUNBOOK-raffwin.md` for installing a server, releasing a new
version, rollback, backups and troubleshooting.

## Buying Raffs: the sales site

Raffs are sold on a separate public site, `https://<sales-host>/`, on another server, with its own
database. **The two never name each other:** the sales site's pages, bundles, responses, redirects
and errors carry no trace of the game's domain, and the Mini App and bot never link to the sales
site. The main API's address lives only in the sales backend's server-side env (`MAIN_API_URL`).
`scripts/check-separation.mjs` enforces it on every sales build and in the tests.

### The payment flow

```
browser            buy-api (sales server)                 Paystack             main API
  | Telegram login  |                                       |                    |
  |---------------->| verify widget hash (SHA-256 of token) |                    |
  |                 |----------- account (signed) ----------------------------->| balance, rate, packages
  | pick an amount  |                                       |                    |
  |---------------->| quote: telegram id, naira, rate id,   |                    |
  |                 | Raffs, bonus, expiry (30 min)         |                    |
  |                 |-- initialize (reference, metadata) -->|                    |
  |<-- redirect to Paystack checkout -----------------------|                    |
  |                 |<-- webhook charge.success (signed) ---|                    |
  |                 | check HMAC-SHA512, answer 200 at once |                    |
  |                 |-- GET /transaction/verify/:ref ------>|                    |
  |                 | status, kobo, NGN, metadata = quote?  |                    |
  |                 | save payment + pending credit (one tx)|                    |
  |                 |----------- credit (signed) ------------------------------->| once per reference:
  |                 |<---------- credited / already ---------------------------- | ledger + purchases row
  | /paid page polls|  delivered                            |                    | bot tells the player
```

- **Credited Raffs come from the stored quote**, never from the rate when the webhook arrives. The
  main API still checks every credit: the rate must be a real hourly quote, the Raffs exactly what
  the naira buys at it, the bonus at most 15%, the naira under the admin's maximum.
- **Time limits:** a quote can be paid for 30 minutes; a payment confirmed within 2 hours of its
  quote is credited at the quote. Later, or with any difference from the quote, it is **flagged**,
  not credited.
- **Delivery** is an outbox: the credit is saved before it is sent, retried after 30 s, 1, 2, 4 ...
  minutes up to hourly, for as long as it takes, and marked delivered only when the main API
  confirms. Refused credits (no account, suspended, out of bounds) are not retried; they are flagged.
- **Flags** (late, mismatch, refused, a day undelivered, unmatched, refund, dispute) go to the main
  API, which records a security event and messages the super and finance admins by bot. They are
  settled by hand: a refund in Paystack, or an admin credit.
- **Reconciliation:** every day at 02:00 Lagos the sales backend lists Paystack's successful
  payments for the two days before, settles any it has no record of, and flags payments with no
  quote. By hand: `node dist/reconcile.js [YYYY-MM-DD from] [YYYY-MM-DD to]`.
- **No account, no sale:** checkout is refused if the Telegram account has no game account yet.

### Configuration

| Where | Variable | What it is |
|---|---|---|
| main API | `RELAY_SECRET`, `RELAY_PATH` | Shared secret and the unguessable path segment; unset = no relay routes |
| main API | `RELAY_SECRET_PREVIOUS` | Only during a rotation (below) |
| main API | `RELAY_ALLOWED_IPS`, `RELAY_CLIENT_IP_HEADER` | Optional allowlist of the sales server; behind Cloudflare the header is `cf-connecting-ip` |
| buy-api | `MAIN_API_URL`, `RELAY_SECRET`, `RELAY_PATH` | Where the main API is (server-side only) and the same secret and path |
| buy-api | `LOGIN_BOT_TOKEN`, `LOGIN_BOT_USERNAME` | A login bot of its own per environment, its domain set in BotFather (`/setdomain`) |
| buy-api | `PAYSTACK_SECRET_KEY` | `sk_test_` on staging, `sk_live_` on production; the process refuses to start otherwise |
| buy-api | `PUBLIC_URL`, `DATABASE_URL`, `IP_HASH_SALT`, `CLIENT_IP_HEADER` | The site's own address, its database, address hashing |
| buy-api | `PAYSTACK_WEBHOOK_IPS`, `QUOTE_MINUTES`, `CREDIT_WINDOW_MINUTES`, `RECONCILE_HOUR` | Optional; defaults in `apps/buy-api/.env.example` |
| buy-web | `VITE_SITE_NAME` | The name the site shows (build time, not secret) |

The Paystack webhook URL is `https://<sales-host>/api/paystack/webhook`, set separately for test
and live mode in the Paystack dashboard.

### Rotating the relay secret

No downtime and no lost credits: the main API accepts the old and the new secret during the switch,
and the sales outbox simply retries anything refused in between.

1. On the **main API** server, generate the new secret there (never on a laptop or in a chat):
   `openssl rand -hex 32 > /root/relay-secret.new` (mode 600). Set `RELAY_SECRET_PREVIOUS` to the
   current value and `RELAY_SECRET` to the new one in the API's env file. Restart the API.
2. Copy the new secret to the **sales** server (scp of the file, never pasted), set it as
   `RELAY_SECRET` in buy-api's env file, restart buy-api.
3. Check the main API's log: no more `relay signed with the previous secret` warnings, and sales
   credits arriving. Then remove `RELAY_SECRET_PREVIOUS` from the API's env and restart it.
4. Confirm a request signed with the old secret now gets 401 (a `relay_bad_signature` security event).

Change `RELAY_PATH` the same way if it ever appears somewhere it should not: set the new path on
both sides (the main API first), then restart both.

Draws exist since 19 Oct (`apps/api/src/services/draw.ts`): a seed committed when a raffle
opens, the draw a few seconds after the deadline (only with at least 5 entries; below that
the raffle is refunded in full), Raffs prizes credited, winners told by the bot, and a live
draw show in every open app (`apps/miniapp/src/features/raffles/LiveDrawShow.tsx`).
