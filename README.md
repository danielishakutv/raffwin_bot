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
packages/
  shared/     Types, validation, request schemas, rate and referral rules used by both apps.
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
- **Raffs:** each raffle has a fixed entry price in Raffs. Raffs are priced in Telegram Stars,
  with a base rate an admin sets and an hourly move of 3% to 15% up or down from that base.
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
players (search, suspend, ask to adjust a balance), settings (rate base, limits, your own
password), security events, the audit log with a tamper check, and admins (add, reset,
disable). Anything that moves money or changes the rate needs a second admin's approval.
Every admin request is recorded in the audit log.

Create the first admin on the server with
`node --env-file=.env dist/create-admin.js --username <name> --name "<full name>" --telegram <telegram username> --role super_admin`.
It prints the password once.

## Deploying

See `infra/runbook/SERVER-RUNBOOK-raffwin.md` for installing a server, releasing a new
version, rollback, backups and troubleshooting.

## Not built yet

- **Buying Raffs with Telegram Stars:** invoices, payment webhooks, refunds, reconciliation.
- **Draws:** a committed seed, the scheduled draw, winner announcements and a public
  verification page.

Until both exist, players can browse, enter with credited Raffs and invite friends. Admins
can credit Raffs through an approved adjustment.
