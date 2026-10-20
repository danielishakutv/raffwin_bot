# Raffle Win: architecture

How the system works and why it is built this way. For running a server, see
`infra/runbook/SERVER-RUNBOOK-raffwin.md`; for local development, see `README.md`.

## 1. Shape of the system

```
Telegram client ──(opens Mini App)──> https://<host>/          static Mini App (Apache)
        │                                    │ fetch /api/v1/*, /api/admin/v1/*
        │                                    ▼
        └──(bot updates)──> https://<host>/api/telegram/webhook ──> API (Node, Express) ──> PostgreSQL
```

- **One host per environment.** The live and test hosts each serve the Mini App and its API
  (`/api`, proxied by Apache to the API on localhost). There is no other website, no admin
  domain and no public sign-up page.
- **Telegram is the only way in.** Telegram loads the Mini App from its public HTTPS address,
  so the page itself can be fetched by anyone. But it shows "Open in Telegram" outside
  Telegram, and every API call needs launch data signed by the bot.
- **Cloudflare** sits in front of both hosts (DNS, TLS at the edge, caching of static files
  only; the API sends `no-store`).

## 2. Code layout

A pnpm workspace:

- `packages/shared`: domain types, error codes, field validation, zod request schemas, the
  hourly rate rule and the referral rule. Both apps import these, so the form, the API and
  the tests cannot disagree.
- `apps/api`: Express 5 API, Drizzle ORM migrations, the Telegram bot (grammY) as a webhook
  route, and command-line tools (migrate, create-admin, master-hash, setup-bot, sample-raffles,
  dev-seed). Bundled with tsup; `@raffwin/shared` is bundled in.
- `apps/miniapp`: React 19 + Vite + Tailwind + Zustand. Without `VITE_API_URL` it runs on
  in-browser demo data (`src/api/mock.ts`). With it, it uses the real API
  (`src/api/http.ts`). Both expose the same functions, so screens never know which one they use.

## 3. Identity and sessions

**Players.** The Mini App posts Telegram's `initData` to `POST /v1/auth/telegram`. The API
checks it exactly as Telegram specifies: an HMAC with the bot token, an `auth_date` no older
than an hour, and a recorded reuse count. It then finds or creates the player and issues a
15-minute access token (JWT) plus a 30-day refresh token. Refresh tokens rotate. Presenting
one that was already rotated means it was copied, so every session from that login is revoked.

There is no sign-up. A new player gets their Telegram username (or a generated
`player_xxxxxx`) and name. The referral bond is set on that first open, from the link's
`start_param`, and never changes.

**Admins.** There is no admin website. Sign-in needs two factors:

- *Possession:* the Telegram account bound to that admin. It is bound on the first
  successful sign-in, and only if its username matches the one a super admin registered.
- *Knowledge:* the master password, then the admin username, then the admin password
  (argon2id). These are typed into the bot chat, after a hidden command or the Admin card's
  **Start admin sign-in** button. The bot deletes each message on reading it. Failures get
  one generic answer, and five in a row lock that Telegram account out for an hour.

A successful sign-in returns a one-time ticket (5 minutes) on an **Open admin** button. The
Mini App exchanges it, together with its own `initData` for the same account, for an admin
bearer token. That token is held in memory only and lasts 8 hours, or 30 minutes idle.
Admins can change their own password. Super admins add, reset and disable admins.

## 4. Money

- **Raffs** are whole numbers. Every movement is a row in the insert-only `ledger`, with the
  balance after it. `users.balance_cache` changes in the same statement, and the admin
  overview checks that the two always agree. Database triggers refuse UPDATE and DELETE on
  `ledger`, `audit_log` and `security_events`.
- **Rate.** An admin sets a base price of one Raff in naira (kobo) and a movement range
  (Settings > Rate and sales; 3% to 15% by default). Each clock hour gets one quote: a move
  inside the range, up or down from the base (never from the previous hour), drawn from a
  CSPRNG. It is stored with the hour as a unique key, so concurrent requests agree on it.
  The rate prices Raffs on the sales site (19 Oct; the Stars base before it is retired);
  raffle entries have a fixed Raffs price.
- **Purchases** arrive from the separate sales site through a signed relay
  (`http/relay.ts`, `@raffwin/relay`): HMAC-SHA256 over timestamp, operation and body, five
  minutes old at most, the old and new secret both accepted during a rotation. A credit is
  checked against the hourly quote it names and written once per payment reference
  (`purchases`, insert-only, unique reference) with its ledger row. See README, "Buying Raffs".
- **Vouchers** (`services/vouchers.ts`): batches approved by a second admin, codes issued once
  and stored as SHA-256 only, redeemed once under the code's row lock, five wrong codes an
  hour per player.
- **Entries.** One transaction locks the raffle row, then the player and their referrer in
  id order (so two entries can never wait on each other). It then checks status, deadline,
  stock, per-raffle and daily caps and the balance, assigns contiguous ticket numbers,
  writes the entry and its ledger row, and credits the referrer 10% (floored). Each
  confirmation carries an idempotency key, so a retried tap returns the same entry.
- **Referrals** pay in Raffs only, single level. Cancelling a raffle refunds every entry
  and reverses the referral credit on each.
- **Maker-checker.** A rate-base change, a balance adjustment or a raffle cancellation
  waits as a pending approval. It runs only when a different admin approves it, and the
  database itself refuses self-approval. A bulk adjustment (the same amount for up to 500
  players picked in Admin > Players, at most 10,000,000 Raffs in all) is one approval,
  applied to every player or none; a bulk debit never takes anyone below zero.

## 5. Prize delivery (KYC)

Asked for only on the KYC page: the name to hand the prize to, the phone (taken from
Telegram's signed contact share, so it is the account's real number, one account per
phone), the state and city, and the nearest motor park. No street address is collected or
stored. Prizes are delivered to the motor park and collected there.

## 6. Live updates

The Mini App polls `GET /v1/live` every 4 seconds while it is on screen. The response is
small: each visible raffle's entry count, target, status and deadline, plus the player's
balance. The app merges counts in place, and fetches full data only when a raffle appears,
disappears or is drawn, or the balance moves. It backs off after failures and shows
"Live updates paused" after three in a row. It reloads everything when it comes back to the
foreground. A poll repairs a missed change within seconds, where a missed push would be lost.
Admin overview, approvals and raffles refresh themselves every 10 to 15 seconds.

## 7. Recording and audit

- **`security_events`:** every rejected login, forged or stale `initData`, reused refresh
  token, bad webhook secret, rate-limit trip, forbidden admin action, failed admin sign-in
  and suspected fraud (someone else's phone, self-referral). Each event has a severity, a
  category, a hashed IP and the action taken.
- **`audit_log`:** every admin request (reads included), every sign-in attempt and every
  change, with before and after values. Each row's hash covers its content and the previous
  row's hash, so altering or removing any row breaks the chain. Admin > Audit > Verify checks it.

## 8. Data model (main tables)

`users`, `sessions`, `initdata_uses`, `delivery_points`, `raffles`, `raffle_prizes`,
`entries`, `ledger`, `referral_earnings`, `rate_quotes`, `settings`, `approvals`,
`admin_users`, `admin_sessions`, `admin_login_flows`, `admin_tickets`, `audit_log`,
`security_events`. Migrations are in `apps/api/drizzle`; they only ever add, never drop.
(`addresses` is an unused table from an earlier design, kept rather than dropped.)

## 9. Hosting

One Linux server (Ubuntu 22.04, Apache 2.4, PostgreSQL 14, Node 22) runs both environments,
each with its own Linux user, database role, env file (mode 600), systemd service bound to
localhost, Apache vhost, Let's Encrypt certificate and nightly `pg_dump`. Details and
commands: `infra/runbook/SERVER-RUNBOOK-raffwin.md`.

## 10. Still to build

1. **Purchases: built 19 Oct** as a separate sales site with Paystack (apps/buy-api,
   apps/buy-web; README, "Buying Raffs"), not inside the Mini App. Still to build: taking
   Raffs back automatically after a Paystack refund or chargeback (today flagged to admins,
   settled by hand).
2. **Draws: built 19 Oct** (`services/draw.ts`, worker loop every 5 s). The seed is fixed
   and its SHA-256 published when a raffle opens. At the deadline, with at least
   `max(5, prizes)` tickets sold, one distinct ticket per place comes from the seed, the
   raffle id and the count (`DRAW_METHOD` in `@raffwin/shared`); fewer, and the raffle is
   cancelled and refunded. The seed is published with the winners, shown under "Check this
   draw". Still to build: a public verification page outside Telegram.
3. **Offsite backups** (a second location for the nightly dumps) and **analytics** (client
   events, dashboards, exports).
