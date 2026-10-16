# Raffle Win: production architecture

Status: in build (milestone 1 started 16 October 2026). Decisions already made by Daniel: Node +
Express + PostgreSQL (no Laravel), Telegram Stars for payment, a referral programme paying 10% of
every referred entry, domain `rafflewin.com.ng`, hosting on the jmnews server, daily backups to
Google Drive plus a second remote, full activity and security logging with an export API, and legal
approval to operate raffles in Nigeria is in place.

Answers to the open questions (16 October 2026), now reflected in the sections below:

- 3 admins at launch.
- Stars per Raff: an admin-set base rate, re-quoted every hour with a random move of 3% to 15%
  up or down, always measured from the base (never from the previous hour), so the quote stays
  within 85% to 115% of the base.
- Referral earnings are paid in Raffs only, never cash; single level; credited immediately.
- Backups go to a personal Google Drive for now (to change later), plus a second remote.
- Toncoin to Naira through Bybit. The super admin holds the TON wallet keys; they never touch the
  server or the dashboard.

The demo in this repository already defines the contract the backend must implement:
`src/data/types.ts` (shapes) and `src/api/index.ts` (operations and error codes). The UI should not
need to change except where new features are added (referrals, Stars checkout, verified phone).

---

## 1. Domain layout

All hostnames sit behind Cloudflare (DNS + proxy). Use single-level subdomains only, because
Cloudflare's free certificate does not cover `a.b.rafflewin.com.ng`.

| Host                              | Serves                                         | Notes                                                        |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `rafflewin.com.ng`, `www`         | Public site: what it is, winners wall, rules, privacy, terms, "Open in Telegram" | Static. Also hosts the draw verification page.   |
| `app.rafflewin.com.ng`            | The Mini App (production build)                | Replaces GitHub Pages. `VITE_BASE_PATH=/`.                   |
| `api.rafflewin.com.ng`            | REST API `/v1/*`, Telegram webhook, health     | Node + Express behind Nginx.                                 |
| `admin.rafflewin.com.ng`          | Admin dashboard                                | Behind Cloudflare Access (Google login + MFA) and IP rules.  |
| `staging-app.rafflewin.com.ng`    | Staging Mini App                               | Opened from the test bot.                                    |
| `staging-api.rafflewin.com.ng`    | Staging API                                    | Own database, own Redis prefix, own bot token.               |
| `staging-admin.rafflewin.com.ng`  | Staging admin                                  | Same Access policy as production.                            |
| `status.rafflewin.com.ng`         | Uptime Kuma status page                        | Optional, public.                                            |

Email: `noreply@rafflewin.com.ng` for transactional mail with SPF, DKIM and DMARC published and
verified by sending a real message to Gmail before launch.

Telegram deep links (no DNS involved):

- Open the app: `https://t.me/raffwin_bot/app`
- Referral: `https://t.me/raffwin_bot/app?startapp=ref_<code>` (also `https://t.me/raffwin_bot?start=ref_<code>`)
- Open a raffle: `https://t.me/raffwin_bot/app?startapp=raffle_<id>`
- Return from payment: handled in-app by `openInvoice`, no link needed.

---

## 2. Repository layout

Convert the repository into a pnpm workspace so the Mini App, admin and API share one set of types.

```
raffwin_bot/
  apps/
    miniapp/      the current src/, public/, index.html, vite.config.ts
    admin/        React + Vite + shadcn/ui admin dashboard
    api/          Express API, Telegram webhook, BullMQ workers, scheduler
    site/         public landing site (static, Vite or plain HTML)
  packages/
    shared/       domain types, zod schemas, rate maths, referral maths, error codes
    config/       shared eslint and tsconfig presets
  infra/
    apache/       vhost templates for every host above (the server runs Apache, section 13)
    scripts/      deploy.sh, backup.sh, restore.sh, restore-drill.sh
    runbook/      SERVER-RUNBOOK.md for the raffle host
  docs/
  .github/workflows/
```

Tooling: pnpm workspaces, Turborepo for task caching, Node 22 LTS, TypeScript strict everywhere,
Vitest for unit and API tests, k6 for load tests. The grammY bot folder folds into `apps/api`
(the webhook is just another route), so there is one deployable backend.

---

## 3. Backend stack and the path to a million users

| Concern           | Choice                                                   | Why                                                                                 |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Runtime           | Node 22 LTS, TypeScript                                  | Same language as the Mini App; shared types.                                        |
| HTTP              | Express 5 with helmet, cors allowlist, pino-http, zod    | Daniel's choice. Fastify is roughly 2 to 3 times faster on raw throughput, but the database, not the framework, is the ceiling for this workload. Swap later only if measured. |
| Validation        | zod schemas in `packages/shared`, used by client and API | One definition of every request and response.                                       |
| Database          | PostgreSQL 14 (the jmnews server's cluster; 17 in local dev), PgBouncer later | Row locks, serialisable money paths, partitioning for events, mature backup tools. Nothing may need a feature newer than 14. |
| ORM               | Drizzle ORM + drizzle-kit migrations                     | SQL-first, type-safe, small, migrations checked into git.                           |
| Cache / sessions  | Redis 7 (from milestone 2; not on the server yet)        | Rate limits, idempotency keys, hot raffle counters, locks. Milestone 1 keeps refresh sessions and initData replay records in Postgres and rate limits in process memory. |
| Queues            | BullMQ on Redis                                          | Draws, notifications, exports, Stars reconciliation, analytics ingestion.           |
| Scheduling        | BullMQ repeatable jobs                                   | Hourly quotes, per-minute draw sweep, daily digest, backup verification.            |
| Logging           | pino JSON to stdout, shipped to Loki                     | Structured, cheap, queryable.                                                       |
| Metrics / traces  | prom-client + Prometheus + Grafana; OpenTelemetry later  | Request rates, latencies, queue depth, DB pool, business counters.                  |
| Errors            | Sentry (hosted) or GlitchTip (self-hosted)               | Frontend and backend, release-tagged.                                               |
| Process manager   | PM2 cluster mode (one worker per core) + systemd         | Zero-downtime reloads.                                                              |
| Edge              | Cloudflare proxy, WAF managed rules, rate limiting, Bot Fight Mode | DDoS absorption before the server sees it.                               |

Processes on the server: `api` (HTTP, clustered), `worker` (BullMQ consumers), `scheduler`
(enqueues repeatables, single instance). All stateless; all state in Postgres and Redis.

Scale stages. One million registered users is not one million concurrent users; a Nigerian consumer
app sees a few percent online at peak. The design above is sized to grow without rewriting:

| Stage               | What changes                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| 0 to 100k users     | One server: Nginx, API cluster, worker, Postgres, Redis. Cloudflare in front.                     |
| 100k to 500k        | Postgres moves to its own host (or managed Postgres), PgBouncer stays with the API. Read replica for analytics and Metabase. Second API host behind Cloudflare load balancing. |
| 500k to 1M+         | Events table moves to ClickHouse; Redis Cluster; API autoscaled across 3+ hosts; object storage for all uploads and exports. |

Rules that keep it fast at every stage: every list endpoint is cursor-paginated; every money
operation is one database transaction with `SELECT ... FOR UPDATE` on the user's balance row; every
write that a client might retry carries an `Idempotency-Key` stored in Redis for 24 hours; hot
counters (entries per raffle) are cached in Redis and reconciled from the ledger.

---

## 4. Data model

Money columns are integers (Raffs are whole units; Stars are whole units). Timestamps are
`timestamptz`. Every table has `created_at`; mutable tables have `updated_at`.

Users and auth

- `users`: id (uuid), telegram_id (unique), username (unique, citext), full_name, phone (E.164, from
  Telegram `requestContact`, verified flag), email, status (active, suspended, banned),
  referral_code (unique, 8 chars), referred_by_user_id, onboarding_completed_at, last_seen_at,
  language_code, tg_platform, risk_score.
- `sessions`: id, user_id, refresh_token_hash, device fingerprint, ip_hash, user_agent, expires_at,
  revoked_at.
- `addresses`: user_id, street, city, state, landmark, phone.
- `kyc_submissions`: user_id, id_object_key, selfie_object_key (encrypted objects in storage),
  status (pending, verified, rejected), reviewer_admin_id, reason, submitted_at, decided_at.
- `contact_prefs`: user_id, whatsapp, telegram, email.

Raffles and draws

- `raffles`: id, slug, prize_name, model, category, kind, hue, market_price_naira, entry_price_naira,
  pool_target_naira, entries_target, deadline, status (draft, scheduled, open, drawing, drawn,
  cancelled), description, rules (jsonb), image_key, seed_commitment (sha256 of the secret seed,
  published while open), seed_revealed, drawn_at, created_by_admin_id.
- `raffle_prizes`: raffle_id, position (1..3), prize_item, prize_type (physical, raffs_credit),
  raffs_value, winner_user_id, winner_entry_ticket (the ticket number that won), fulfilment_status
  (pending, contacted, confirmed, dispatched, delivered, forfeited), tracking_ref, delivered_at.
- `rate_quotes`: id, stars_per_raff (numeric), naira_per_raff (display only), issued_at,
  expires_at, source (manual, formula), created_by_admin_id.
- `entries`: id, user_id, raffle_id, qty, raffs_spent, rate_quote_id, ticket_from, ticket_to
  (contiguous ticket numbers assigned under the raffle's row lock), created_at.

Money

- `ledger`: id, user_id, type (purchase, entry, bonus, prize, refund, referral,
  referral_reversal, adjustment), raffs (signed), stars (nullable), naira_value (nullable),
  reference_type, reference_id, note, status, created_at. Balance is `SUM(raffs)` per user;
  `users.balance_cache` is maintained in the same transaction and checked nightly against the sum.
- `star_payments`: id, user_id, invoice_payload (unique), telegram_payment_charge_id (unique),
  stars, raffs_credited, bonus_raffs, package_id, status (pending, paid, refunded, disputed),
  pre_checkout_at, paid_at, refunded_at, raw (jsonb of the Telegram objects).
- `packages`: id, stars, bonus_pct, tag, active, sort.
- `referral_earnings`: id, referrer_user_id, referred_user_id, entry_id, raffs (10% of
  entry.raffs_spent, floored), ledger_id, created_at, reversed_at, reversal_ledger_id.

Admin and security

- `admin_users`: id, email, password_hash (argon2id), totp_secret (encrypted), passkeys (jsonb),
  role_id, status, last_login_at, must_rotate_password_at.
- `admin_roles`, `admin_permissions`, `admin_role_permissions`.
- `admin_sessions`: short-lived, device-bound, revocable.
- `audit_log`: id, admin_id, action, target_type, target_id, before (jsonb), after (jsonb), ip,
  user_agent, created_at, prev_hash, hash (sha256 over the row and the previous hash: tampering
  breaks the chain). Insert-only; the database role used by the API has no UPDATE or DELETE on it.
- `approvals`: maker-checker for sensitive actions (balance adjustments, rate changes, draw
  overrides, refunds, prize marking, admin creation). requested_by, approved_by (must differ),
  payload, status, expires_at.
- `security_events`: id, occurred_at, severity, category (auth, initdata, webhook, ratelimit,
  waf, fraud, admin, integrity), fingerprint (ip_hash + category + route), ip_hash, country,
  user_id, admin_id, route, details (jsonb), action_taken (none, throttled, blocked, banned).

Logging and analytics

- `events` (partitioned by month): id, occurred_at, received_at, user_id, anon_id, session_id,
  name, props (jsonb), screen, app_version, tg_platform, tg_version, device (jsonb),
  ip_hash, country, source (client, server).
- `bot_events`: update_id (unique), telegram_id, chat_id, kind (command, message, callback,
  pre_checkout, successful_payment, my_chat_member, write_access), command, payload (jsonb),
  reply_sent, latency_ms, occurred_at.
- `notifications`: user_id, channel (telegram, email), template, payload, status, sent_at, error.
- `export_jobs`: requested_by_admin_id, dataset, filters (jsonb), format, status, row_count,
  object_key, expires_at.
- `settings`: key, value (jsonb), updated_by, updated_at (remote config and feature flags).
- `support_tickets`: user_id, source (paysupport, in_app, bot), subject, status, assignee.

---

## 5. Authentication

Mini App users

1. The app posts `initData` to `POST /v1/auth/telegram`.
2. The API validates it exactly as Telegram specifies: sort the fields, join with `\n`, derive
   `secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)`, compare
   `HMAC_SHA256(key=secret_key, message=data_check_string)` with `hash` in constant time.
3. Reject if `auth_date` is older than 1 hour or already used (the hash is cached in Redis for
   its validity window to stop replays). Every rejection is a `security_events` row.
4. On success, find or create the user by `telegram_id`, then issue a 15-minute access JWT and a
   30-day rotating refresh token (opaque, stored hashed in `sessions`). Refresh rotation detects
   token theft: reuse of a rotated token revokes the whole session family.
5. Sign-up collects full name, username and email. The phone number comes from Telegram's
   `requestContact` prompt, so it is verified by Telegram rather than typed. One Telegram account
   maps to one user; one verified phone maps to one user.

Admin users: separate tables, separate cookie, separate origin. See section 9.

---

## 6. Money: Telegram Stars to Raffs

How Stars work (verified against Telegram's Bot Developer Terms and Bot Payments docs on
16 October 2026)

- Users buy Stars from Telegram through Apple, Google or Telegram's web shop. Telegram requires
  that digital goods sold inside bots and Mini Apps are paid for with Stars only (Developer Terms
  section 6.2). Raffs are a digital good, so this is the compliant path. Physical prizes are not
  sold for Stars; they are won.
- The bot must answer the `/paysupport` command (section 6.2.1).
- Each Star in the bot's balance is worth 0.02 USD of Telegram advertising credit (section
  6.2.3) or 0.013 USD of rewards paid out through Fragment (section 6.2.4). Fragment may be
  unable to pay out in some countries (section 6.2.4.1); test a small withdrawal before launch.
- Stars in a bot balance expire after 3 years (section 6.2.7).
- Telegram may withhold or debit Stars after refunds or suspected abuse (section 6.2.4).
- Third-party guides state a 21-day hold after each payment and a 1,000-Star minimum per
  withdrawal. Confirm both on Fragment with the first real withdrawal.

Payment flow in the app

1. User picks a package. The API prices it with the current quote and creates an invoice:
   `createInvoiceLink` with `currency: "XTR"`, no provider token, `payload` = our
   `star_payments.id`, `prices: [{ label, amount: stars }]`. A `star_payments` row is inserted
   as `pending`.
2. The Mini App calls `Telegram.WebApp.openInvoice(link, callback)`. The callback reports
   `paid`, `cancelled`, `failed` or `pending`. The app never credits anything itself.
3. Telegram sends `pre_checkout_query` to the webhook. The API must answer within 10 seconds:
   it checks the payload exists, is pending, the user is not suspended, and the amount matches.
   This handler does one indexed lookup and nothing else.
4. Telegram sends `successful_payment`. The API credits Raffs inside one transaction keyed on
   `telegram_payment_charge_id` (unique index makes duplicates impossible), writes the ledger
   row, applies the package bonus, and pushes a `balance_updated` notification.
5. Refunds: `refundStarPayment` from the admin (with approval), which debits Raffs; if the user
   already spent them the balance goes negative and the account is flagged. Referral earnings
   derived from entries funded by that purchase are reversed.
6. Reconciliation: a nightly job pulls `getStarTransactions` and compares with `star_payments`;
   any difference is a critical alert. `getMyStarBalance` is recorded daily for the finance view.

Pricing. Replace "Naira per Raff" with "Stars per Raff" as the quoted unit; keep a Naira figure
for display only. Example at 1 Star ≈ 0.013 USD payout and ₦1,500 per USD: 1 Star ≈ ₦19.5 of
revenue to Raffle Win, so 1 Star ≈ 2 Raffs keeps the demo's ₦10 per Raff economics.

Decided: the admin sets a base Stars-per-Raff rate. Every hour the scheduler issues a new quote:
a magnitude drawn uniformly from 3% to 15% and a random sign, both from a CSPRNG, applied to the
base: `quote = base × (1 ± m)`. It is always measured from the base, so the quote can never drift
outside 85% to 115% of it. Each quote is stored (`rate_quotes`), every entry and purchase records
the quote it was priced with, and a stale quote returns `RATE_EXPIRED`. Changing the base is a
maker-checker action.

How the money reaches Raffle Win

1. Stars accumulate on `@raffwin_bot`'s balance (visible in BotFather and via the API).
2. After the hold period, withdraw on Fragment (`fragment.com/stars`) with a TON wallet connected
   (Tonkeeper or similar). Stars convert to Toncoin at the rate Fragment shows at that moment.
3. Sell Toncoin for Naira on Bybit (decided), then transfer to the company bank account. The
   super admin holds the TON wallet keys; the server and the dashboard never see them. The finance
   module follows the wallet's public address read-only and records each Fragment withdrawal and
   Bybit sale for tax; section 6.4 makes taxes the developer's responsibility.
4. Alternative that is worth more per Star: spend Stars on Telegram Ads at the 0.02 USD rate
   (about 54% more value than cashing out) to acquire users. Decide a split, for example cash out
   what covers prizes and operations, and advertise with the rest.

---

## 7. Referral programme

Rules

- Every user has a referral code and link from the moment they sign up.
- A new user is bound to a referrer once, at sign-up, from `start_param` (`ref_<code>`). The bond
  never changes. Self-referral is rejected (same Telegram ID, same verified phone, or same device
  fingerprint as the referrer).
- On every entry the referred user makes, the referrer is credited 10% of the Raffs spent on that
  entry, floored to a whole Raff, as a `referral` ledger row. 10 referrals each entering raffles
  worth 1,000 Raffs earn the referrer 100 Raffs per entry, 1,000 Raffs in total.
- Credit is immediate (entries are final). If the entry's funding purchase is refunded, the
  earning is reversed with a `referral_reversal` row.
- Single level only. Telegram's Developer Terms section 5.2(d) prohibit MLM and ponzi schemes;
  a flat 10% affiliate reward is a standard referral programme, a multi-level one is not.
- Referral Raffs can only be spent on entries, never cashed out, so the cost to Raffle Win is
  pool dilution, not cash.

Tracker (new Mini App screen `/referrals`)

- The link, a copy button and a share button (`shareMessage` with a prepared inline message that
  carries the link and a raffle card, or the `https://t.me/share/url` fallback).
- Totals: people referred, active this month, lifetime Raffs earned, Raffs earned this month.
- A list of referred users (username, joined date, entries made, Raffs you earned from them).
- A per-entry statement (date, raffle, their entry size, your 10%).
- Endpoints: `GET /v1/referrals/summary`, `GET /v1/referrals/people?cursor=`,
  `GET /v1/referrals/earnings?cursor=`.

Fraud controls: velocity limits on sign-ups per device and IP, duplicate phone detection, a
review queue for referrers whose referred users never fund an account, and admin tools to freeze
earnings on a referrer pending review.

---

## 8. Raffles, rate, entries, draws

- Admin creates raffles as drafts, schedules them, and the scheduler opens them.
- Quotes are issued by the scheduler (hourly) or set manually; every entry stores the quote id it
  was priced with, and the API re-prices server side: a stale quote id returns `RATE_EXPIRED`.
- Entering: one transaction locks the user's balance row and the raffle row, checks status and
  remaining tickets, assigns a contiguous ticket range, writes `entries` and the `ledger` row,
  credits the referrer, updates the Redis counter, and publishes the new count.
- Draw (scheduler, every minute, for raffles past their deadline): the secret seed whose SHA-256
  was published when the raffle opened is combined with the final ticket count; three distinct
  winning ticket numbers are derived with a CSPRNG seeded from that value; the seed is then
  revealed so anyone can recompute the result on the public verification page. The demo's
  "signed-in user always wins" rule is removed.
- Winners get a bot message and an in-app banner; Raffs prizes are credited by the same job;
  physical prizes enter the fulfilment pipeline (section 9).
- Entry cap per confirmation stays at 50; a per-user per-raffle cap and a daily spend cap are
  admin settings (responsible-play controls).

---

## 9. Admin dashboard and security architecture

Modules: overview (live KPIs), raffles (create, schedule, edit, cancel, draw audit), prizes and
fulfilment (inventory, dispatch, tracking, delivered proof), users (search, profile, ledger,
entries, sessions, risk flags, suspend), KYC review queue, payments (Stars, refunds, reconciliation),
finance (Stars received, Raffs issued, Raffs outstanding as liability, prize cost and margin per
raffle, referral cost, withdrawals), referrals (top referrers, fraud review), notifications
(templates, campaigns, delivery stats), analytics (funnels, retention, cohorts, raffle performance),
security (events, bans, allowlists, admin sessions), audit log, exports, settings (rate, packages,
caps, feature flags), support inbox (`/paysupport` and in-app tickets), system (queues, jobs,
backups, health).

Security controls

- Network: `admin.` sits behind Cloudflare Access (Google Workspace login with MFA, device
  posture optional). Origin accepts admin traffic only from Cloudflare IPs and only with a valid
  Access JWT. Direct IP access to the origin is firewalled.
- Identity: email + argon2id password + mandatory TOTP, with passkeys (WebAuthn) preferred.
  Sessions are 8 hours with a 30-minute idle timeout, bound to IP range and user agent, listed and
  revocable. Step-up re-authentication before any sensitive action.
- Authorisation: role-based with explicit permissions (viewer, support, kyc_reviewer,
  raffle_manager, finance, security, super_admin). Maker-checker approval for balance adjustments,
  rate changes, refunds, draw overrides, prize marking, admin creation and exports of PII.
- Database: separate roles for `api` (no DDL, no DELETE on ledger, audit or events), `admin_api`,
  `readonly` (Metabase, exports) and `backup`. KYC images are encrypted with a key outside the
  database and stored in object storage, never on the web root.
- Application: helmet with a strict CSP, HSTS preload, SameSite cookies, CSRF tokens on the admin,
  zod on every input, parameterised queries only, rate limits per IP and per account, request
  body limits, dependency audit and Semgrep in CI, secrets in an environment file with mode 600
  (or Infisical) and a documented rotation for the bot token and JWT keys.
- Server: SSH keys only, non-standard port, fail2ban with escalating bans and a recidive jail,
  CrowdSec, unattended security updates, auditd on `/etc` and the app directory, swap, watchdog,
  runbook (the standards from the 2026-08-25 incident apply from day one).

Recording attempts and attacks

- Every rejected `initData`, stale or replayed `auth_date`, failed admin login or MFA, bad webhook
  secret, rate-limit trip, CSRF failure, invalid JWT, forbidden permission call, and WAF block
  becomes a `security_events` row with a fingerprint, severity and the action taken.
- Honeypot routes (`/wp-login.php`, `/.env`, `/admin` on the API host) record scanners and ban
  the source for 24 hours at the Cloudflare and firewall level.
- Thresholds in Redis escalate automatically: throttle, then block, then ban, with the ban
  pushed to a Cloudflare IP list through the API.
- Alerts go to a private Telegram admin channel and email within a minute for high severity;
  a weekly security report (top sources, categories, trends, new patterns) is generated
  automatically so the controls improve from real data.
- Cloudflare's own analytics (firewall events) are pulled through its GraphQL API into the same
  security view, so edge blocks and origin blocks are read together.

---

## 10. Activity, behaviour and bot logging

Client events (batched, sent every 5 seconds or on background, retried, deduplicated by event id):
app_open, screen_view, signup_started, signup_completed, onboarding_step, onboarding_completed,
deck_swipe, raffle_opened, entry_started, entry_qty_changed, entry_confirmed, entry_failed (with
reason code), wallet_opened, package_selected, invoice_opened, invoice_closed (status),
referral_link_copied, referral_shared, profile_edited, kyc_started, kyc_submitted, mute_toggled,
rate_refreshed, error_shown (code), app_background, app_foreground. Each carries screen,
app_version, tg_platform, tg_version, colour scheme, viewport and a session id.

Server events: user_created, purchase_credited, entry_recorded, referral_credited, draw_run,
prize_credited, notification_sent, kyc_decided, rate_issued, plus every bot update in
`bot_events` (command, text, callback, payment steps, blocked or unblocked the bot).

Storage: the partitioned `events` table in Postgres is enough to about 100 million rows; after
that, mirror to ClickHouse and keep Postgres for 90 days. Metabase on the read-only role gives
dashboards without code: funnel (open to sign-up to first entry to first purchase), retention
cohorts, revenue per user, raffle fill rate and time to fill, referral K-factor, rate elasticity,
notification response, support load.

Privacy: Nigeria's Data Protection Act 2023 applies. Collect consent at onboarding, publish the
privacy policy on the public site, hash IPs, keep KYC images encrypted and purge rejected ones
after 30 days, and provide user data export and deletion through support.

Export API (admin, permission `export`, every call audit-logged)

- `GET /admin/v1/export/{events|users|entries|ledger|star_payments|referral_earnings|security_events|bot_events|audit_log|notifications}`
- Filters: `from`, `to`, `user_id`, `raffle_id`, `name` (event), `category`, `severity`, free
  `q` on notes; `cursor` and `limit` (max 10,000) for paging.
- `format=json` (array), `format=ndjson` (streamed, one row per line, gzip when accepted),
  `format=csv`.
- Large ranges: `POST /admin/v1/export/jobs` creates an `export_jobs` row, the worker streams the
  result to object storage, and the admin gets a signed download link valid for 24 hours.
- Personal API keys per admin (scoped, expiring, revocable) for scripts and BI tools.

---

## 11. Backups and restore

- Postgres: pgBackRest with continuous WAL archiving (point-in-time recovery, RPO under 5
  minutes) plus a nightly full backup. A nightly `pg_dump --format=custom` is also taken for
  portability across versions.
- Object storage (KYC images, exports, prize photos): versioned bucket, nightly `rclone sync`
  to the second remote.
- Server config: `/etc/nginx`, PM2 ecosystem files, environment files (encrypted), scripts.
- Encryption: every artefact is encrypted with `age` to a public key; the private key lives in
  the company password manager and offline, never on the server.
- Destinations: Google Drive via `rclone` (decided: a personal Google account for now, so an
  OAuth token rather than a service account; the watchdog must alert when that token stops
  working, because it can lapse) and an S3-compatible bucket in a different provider (Cloudflare
  R2 or Backblaze B2). Two copies, two providers. Artefacts are `age`-encrypted before upload, so
  Google only ever holds ciphertext.
- Retention: WAL 7 days, daily 30 days, weekly 12 weeks, monthly 12 months.
- Restore: `infra/scripts/restore.sh <backup-id> <target-db>` fetches, decrypts, restores and runs
  checks (row counts per table, ledger sums equal balance cache, latest draw reproducible).
  `restore-drill.sh` runs this monthly into the staging database and posts the result to the admin
  channel. A restore that has not been rehearsed is not a backup.
- Monitoring: the watchdog alerts if the latest backup is older than 26 hours, smaller than 80% of
  the previous one, or failed its checksum.

---

## 12. Monitoring and alerting

- External: Uptime Kuma checks `app`, `api/health`, `admin`, the webhook endpoint and the bot's
  `getMe`, every minute, from outside the server.
- Server: node_exporter, postgres_exporter, redis_exporter, Nginx logs to Loki, pino logs to Loki,
  Prometheus + Grafana dashboards, alert rules for latency, error rate, queue depth, DB
  connections, disk, TCP memory and load, in line with the existing server watchdog.
- Product: a daily digest bot message (sign-ups, purchases in Stars, entries, revenue, referrals,
  security events, backup status, queue health) and real-time alerts for payment reconciliation
  mismatches, draw failures and webhook errors.
- Everything above is exportable through the same export API or Grafana's own API.

---

## 13. Hosting on the jmnews server

What it is (read-only review, 16 October 2026, each fact checked at least two ways): 161.97.173.118,
Ubuntu 22.04.5, 4 vCPU, 7.8 GB RAM (about 5.2 GB free), 4 GB swap, 63 GB disk free. It already
runs jmnews.ng, mutara.ng and Veriflow (admin.bincikeint.org and s.bincikeint.org) behind
**Apache 2.4** (mod_proxy, mod_remoteip with Cloudflare ranges), PostgreSQL 14 with one role per
app, Node 22 under systemd and PM2. There is no Nginx and no Redis. Raffle Win therefore uses
Apache vhosts proxying to Node on localhost (API on 127.0.0.1:3100; 3001 to 3003 and 4500 are
taken), its own database and role on the existing Postgres 14 cluster, and a Redis instance on a
Unix socket from milestone 2. Server problems found in that review are tracked separately and must
be fixed before the first Raffle Win deploy (root password SSH, Webmin open to the internet, the
broken recidive jail, no offsite backups, Mutara not backed up, origin reachable around
Cloudflare, a pending reboot).

Original requirements: Ubuntu 22.04 or 24.04, root or sudo over SSH, Node 22, PostgreSQL 17, Redis 7,
Nginx, at least 8 GB RAM and 4 vCPU for launch, 4 GB swap, NVMe disk with 50 GB free.

Isolation from whatever else runs there: a dedicated Linux user (`rafflewin`), its own Postgres
cluster (or at least its own database and roles), its own Redis instance on a Unix socket, its
own Nginx vhosts, firewall open only on 22 (restricted), 80 and 443, and Cloudflare in front so
the origin IP is never published. If the server is a shared Apache or cPanel box, Node runs on
localhost ports behind Nginx or Apache as a reverse proxy; the database should move to a dedicated
host before 100k users.

Before anything is deployed: confirm the specifications, what else runs there, and apply the
production server standards (swap, watchdog that emails, verified mail path, fail2ban with
escalating bans, runbook).

---

## 14. Environments and CI/CD

| Environment | Branch    | Hosts                             | Bot                 | Data                      |
| ----------- | --------- | --------------------------------- | ------------------- | ------------------------- |
| Development | any       | localhost (Docker Compose for Postgres and Redis) | local test bot | seed script               |
| Staging     | `staging` | `staging-*` hosts                 | `@raffwin_test_bot` | own DB, anonymised copy   |
| Production  | `main`    | `app`, `api`, `admin`             | `@raffwin_bot`      | production                |

CI on every push: typecheck, lint, unit and API tests against a Postgres service container,
build all apps, dependency audit, Semgrep. Deploy on merge to `staging` or `main` over SSH:
build artefacts, upload, run migrations, `pm2 reload`, smoke test, post result to the admin
channel. Rollback is a tag checkout and reload; migrations are forward-only and backwards
compatible for one release.

---

## 15. Build order

1. Workspace restructure, shared package, API skeleton, Telegram auth, sign-up with verified
   phone, bootstrap endpoint, profile and address, referral code and binding. Mini App switched
   to the API. Staging and production hosts live. Backups, monitoring and the watchdog in place
   from this milestone, not later.
2. Admin foundation: Access, MFA, roles, audit log, security events, settings. Raffle management,
   quotes, entries with ticket ranges, referral earnings and the referral tracker screen.
3. Telegram Stars: packages, invoice links, webhook handling, crediting, refunds,
   reconciliation, finance view. Demo card sheet removed.
4. Draws: seed commitment, scheduler, verification page, winner notifications, prize
   fulfilment pipeline.
5. KYC review queue with encrypted storage, delivery requirements for physical prizes,
   responsible-play caps.
6. Analytics: client SDK, event pipeline, Metabase dashboards, export API, daily digest.
7. Launch hardening: load test with k6 to 10x expected peak, restore drill, security review,
   Telegram terms review with the licence documents ready, soft launch to a closed group.

---

## 16. Open questions

Answered 16 October 2026 (see the top of this document): server specifications (section 13),
3 admins, base rate with an hourly 3% to 15% move from the base, referral earnings in Raffs only,
personal Google Drive for now, Bybit with the super admin holding the TON keys.

Still open:

1. Cloudflare Access for `admin.`: without Google Workspace, use Access's one-time PIN by email
   or personal Google login for the 3 admins. Which?
2. How raffle entries are priced once Stars arrive: in Naira converted at the hourly quote (as the
   demo does), or directly in Raffs with the hourly quote applying only to buying Raffs.
3. The Telegram contact-share flow (`requestContact`) must be confirmed on a real Android and
   iOS device before launch: the API verifies its signed response with the bot token.
