# Raffle Win - Telegram Mini App (demo)

Raffle Win is a gamified raffle app that runs inside Telegram. Members buy **Raffs** with Naira, enter
raffles for phones, laptops, TVs and cash, and watch each draw pick three winners.

This repository is the **frontend-only demo** plus a minimal companion bot. Every number, name and
transaction is generated from local demo data. There is no real backend, no real payment and no real
identity check. The data and API layers are structured so the real backend can be plugged in later
without rewriting the UI (see [Swapping in the real backend](#swapping-in-the-real-backend)).

| Environment | Branch    | URL                                                   | Bot                 |
| ----------- | --------- | ----------------------------------------------------- | ------------------- |
| Production  | `main`    | https://danielishakutv.github.io/raffwin_bot/         | `@raffwin_bot`      |
| Staging     | `staging` | https://danielishakutv.github.io/raffwin_bot/staging/ | `@raffwin_test_bot` |

Staging shows a small **STAGING** badge in the top-right corner so testers never confuse the two.

---

## 1. Quick start (local)

```bash
npm install
npm run dev          # http://localhost:5173  (browser bypass is ON in .env.development)
```

Other commands:

```bash
npm run build          # production build  (.env.production, base path /raffwin_bot/)
npm run build:staging  # staging build     (.env.staging,    base path /raffwin_bot/staging/)
npm run preview        # serve the last build locally
npm run typecheck      # tsc -b
npm run lint           # eslint .
npm run bot            # run the Telegram bot locally with long polling (needs bot/.env)
```

Requirements: Node 20 or newer (the project is built and tested on Node 22).

### The Telegram gate

The app only runs inside Telegram. On load it checks `window.Telegram.WebApp.initData`; when that is
empty it shows a full-screen "Open Raffle Win in Telegram" page with a button to `https://t.me/raffwin_bot`.

The only exception is the dev bypass `VITE_ALLOW_BROWSER=true`, which `.env.development` sets so
`npm run dev` works in a normal browser. Production builds ignore the flag entirely (see
`src/services/env.ts`), so it cannot be switched on by mistake.

---

## 2. What the demo does

Full flow, all working with local demo data:

1. **Splash** - animated logo intro (about 1.8 s), then routes by account state.
2. **Sign up** - full name, username (live "available" check against a demo list), Nigerian phone
   number with the +234 helper, email. Friendly inline validation.
3. **Onboarding** - three swipeable steps: welcome hero, how it works, rules and regulations. The
   "Agree and continue" button is disabled until the checkbox is ticked.
4. **Dashboard** - greeting, Raffs balance (animated counter), Naira-to-Raffs rate chip with its
   one-hour expiry countdown, analytics tiles (entries made with a 7-day sparkline, active raffles,
   raffles won, Raffs spent this month), next draw with a live countdown, "Fund my account" CTA,
   mute toggle, link to profile.
5. **Raffles** - the swipe deck. Drag left/right (with snap and momentum), tilt on touch, progress
   dots, a swipe hint on first use. Each ticket shows prize, model, market value, entry pool,
   entries vs target, entry cost in Raffs at the live rate, live countdown (pulses under one hour),
   the three winner prizes and the Enter CTA. Tap a card for the detail sheet.
6. **Enter a raffle** - quantity stepper, live totals in Raffs and Naira, confirmation step, then a
   confetti burst, chime, balance deduction and the entry count ticking up. Insufficient Raffs show a
   friendly "fund your account" prompt instead.
7. **Draws** - two raffles are already drawn (winners shown, "DRAWN" stamp). One raffle is in
   "Drawing now": open it and press **Reveal the winners** for the drumroll reveal (3rd, 2nd, then
   1st). The demo account entered that raffle, so you will see the "You won!" moment.
8. **Wallet** - packages (₦1,000 / ₦5,000 +5% / ₦10,000 +10% / ₦25,000 +15%) or a custom amount,
   order summary with the demo service fee, "Pay with card" opens a fake card form, a processing
   animation, then success (confetti, fanfare, balance ticks up). A "Simulate a declined card" switch
   exercises the failure path. Card fields live in component state only and are never persisted.
9. **Profile** - avatar, verification badge, expandable sections for personal info, delivery address
   (Nigerian states dropdown), identity verification (ID + selfie upload with previews, "Pending
   review" after submission) and contact preferences. Links to transaction history, my entries and
   my wins. Sound settings. Demo controls (flip verification outcome, refresh the rate now, reset demo
   data, sign out).
10. **Rate** - the Naira/Raffs rate is valid for exactly one clock hour. When it expires every Raffs
    price shows "Refreshing rate" until the next quote arrives.

Sounds (all synthesised with the Web Audio API, no audio files): click, pop, whoosh on swipe, rising
chime on entry, fanfare on wins and purchases, drumroll during the reveal, and an optional soft
background tune. Audio starts only after the first tap, as Telegram requires. The mute toggle is
remembered.

---

## 3. Routes

Routing is hash-based (`/#/home`) because GitHub Pages cannot rewrite deep links to `index.html`.

| Route              | Screen                                                  |
| ------------------ | ------------------------------------------------------- |
| `/`                | Splash, then redirect by account state                  |
| `/signup`          | Create account                                          |
| `/onboarding`      | Welcome, how it works, rules (agree gate)               |
| `/home`            | Dashboard                                               |
| `/raffles`         | Swipe deck                                              |
| `/raffles/:id`     | Deck with the detail sheet open for that raffle         |
| `/wallet`          | Buy Raffs (demo card payment)                           |
| `/profile`         | Profile, address, verification, contact, settings       |
| `/profile/history` | Transaction history                                     |
| `/profile/entries` | My entries                                              |
| `/profile/wins`    | My wins                                                 |

---

## 4. Environment variables

All variables are listed in `.env.example`. Only `VITE_`-prefixed values reach the browser bundle, and
nothing in these files is secret.

| Variable             | Development | Staging                   | Production      | Purpose                                              |
| -------------------- | ----------- | ------------------------- | --------------- | ---------------------------------------------------- |
| `VITE_APP_ENV`       | development | staging                   | production      | Shows the STAGING badge; hard-disables the bypass    |
| `VITE_BOT_USERNAME`  | raffwin_bot | raffwin_test_bot          | raffwin_bot     | Bot the gate links to                                |
| `VITE_ALLOW_BROWSER` | true        | false                     | (unset)         | Dev bypass for the Telegram gate                     |
| `VITE_APP_VERSION`   | (empty)     | (empty)                   | (empty)         | Empty = `package.json` version + git SHA at build    |
| `VITE_BASE_PATH`     | /           | /raffwin_bot/staging/     | /raffwin_bot/   | Base URL path (GitHub Pages project site)            |

Files: `.env.development` (npm run dev), `.env.staging` (npm run build:staging), `.env.production`
(npm run build). Vite picks the file by mode.

Bot variables live in `bot/.env` (copy `bot/.env.example`): `BOT_TOKEN`, `BOT_WEBAPP_URL`, `BOT_ENV`,
and for webhook hosting `WEBHOOK_URL`, `WEBHOOK_SECRET`, `PORT`.

---

## 5. Deployment (GitHub Pages, both environments)

Both environments are served from this repository's single GitHub Pages site by
`.github/workflows/pages.yml`:

- a push to **`main`** or **`staging`** runs the workflow;
- it checks out **both** branches, builds `main` with `npm run build` (production env) and `staging`
  with `npm run build:staging` (staging env);
- it assembles one site: production at the root, staging under `/staging/`, plus a `404.html` copy of
  `index.html` for safety, and deploys it.

Because every run rebuilds both branches from their current heads, one environment can never
overwrite the other.

### One-time setup (already done for this repo, listed for reference)

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (and `staging`). Watch **Actions → Deploy to GitHub Pages**.
3. Production: https://danielishakutv.github.io/raffwin_bot/
   Staging: https://danielishakutv.github.io/raffwin_bot/staging/

### Day-to-day

```bash
# ship to staging
git checkout staging && git merge main && git push origin staging

# ship to production
git checkout main && git push origin main
```

`.github/workflows/ci.yml` runs typecheck, lint and both builds (plus the bot typecheck/build) on every
push and pull request to `main` and `staging`.

### Custom domain later

If you move to `raffwin.<your-domain>` (and `staging.raffwin.<your-domain>`), set `VITE_BASE_PATH=/` in
`.env.production` / `.env.staging`, add the domain in Settings → Pages, and point the bots at the new
URLs. Staging would then need its own Pages site (for example a fork or a second repo) because one
repository has one Pages site.

---

## 6. Telegram setup guide

The Mini App is opened by Telegram, so the bot has to know the URL. Nothing here needs the bot
process to be running: the menu button and the Mini App are configured in BotFather.

### Production (`@raffwin_bot`)

1. Open **@BotFather** in Telegram.
2. Send `/setmenubutton`, pick `@raffwin_bot`, send the URL
   `https://danielishakutv.github.io/raffwin_bot/`, then a button title, for example `Open Raffle Win`.
   The menu button (next to the message box) now opens the app.
3. Optional but recommended: `/newapp`, pick `@raffwin_bot`, fill in title, description, a photo
   (640x360) and the same URL, and choose a short name such as `app`. The app then also opens from
   the direct link `https://t.me/raffwin_bot/app`.
4. `/setdescription` and `/setabouttext` for `@raffwin_bot` - suggested texts:
   - Description: "Raffle Win - buy Raffs, enter raffles for phones, laptops, TVs and cash, and watch
     the draw pick three winners. Tap Start to open the app."
   - About: "Gamified raffles inside Telegram. One draw per raffle, three winners."
5. Test: open `https://t.me/raffwin_bot`, press **Start**, then tap **Open Raffle Win** (the inline
   button from the bot, or the menu button). Inside Telegram the gate passes and the app loads;
   in a normal browser you see the "Open in Telegram" page, which is the intended behaviour.

### Staging (`@raffwin_test_bot`)

Create a second bot so testers can use staging while real users stay on production:

1. In BotFather: `/newbot`, name `Raffle Win Test`, username `raffwin_test_bot` (or any free name;
   then change `VITE_BOT_USERNAME` in `.env.staging` to match).
2. `/setmenubutton` for the test bot with
   `https://danielishakutv.github.io/raffwin_bot/staging/`.
3. Optionally `/newapp` for the test bot with the same staging URL.
4. Open the test bot, press Start, tap the button, and confirm the **STAGING** badge is visible.

### Running the bot's commands (/start, /help, /rules)

The inline "Open Raffle Win" button in the bot's replies comes from the bot code in `bot/`, which must
be running somewhere. For the demo the menu button alone is enough; to also have the command replies:

**Locally (long polling)**

```bash
cd bot
cp .env.example .env      # put the real BOT_TOKEN and the Mini App URL in it
npm install
npm run dev               # polling; Ctrl+C to stop
```

**Hosted (webhook)** - Render, Railway or any Node host:

```bash
cd bot && npm install && npm run build && npm run start:webhook   # listens on $PORT, POST /api/webhook
# once, from your machine, with WEBHOOK_URL=https://<host>/api/webhook in bot/.env:
npm run set-webhook
```

Vercel: deploy the `bot/` folder as its own project; `bot/api/webhook.ts` is the serverless entry.
Set `BOT_TOKEN`, `BOT_WEBAPP_URL` (and optionally `WEBHOOK_SECRET`) in the project settings, then run
`npm run set-webhook` with `WEBHOOK_URL=https://<project>.vercel.app/api/webhook`.

`npm run delete-webhook` switches back to polling.

The same bot code serves both environments; only `BOT_WEBAPP_URL` (and `BOT_TOKEN`) differ.

---

## 7. Test checklist for the demo

Open the app in Telegram (or `npm run dev` in a browser) and try:

- [ ] Sign up: try a taken username such as `ada_obi` (shows "taken"), then your own (shows "available").
- [ ] Onboarding: swipe between the steps; the agree button stays disabled until the box is ticked.
- [ ] Dashboard: numbers count up; the rate chip shows the minutes left in the hour.
- [ ] Raffles: swipe the deck; the first card closes in under an hour and pulses magenta.
- [ ] Enter a raffle: change the quantity, confirm, watch the confetti, balance and entry count.
- [ ] Spend more than you have: the sheet offers "Fund my account" instead of failing.
- [ ] Drawing now (Infinix Hot 50): reveal the winners, watch the drumroll and the "You won!" banner.
- [ ] Wallet: buy a package, then try again with "Simulate a declined card" switched on.
- [ ] Profile: edit personal info (save animation), add an address, upload an ID and a selfie, flip
      the verification outcome from Demo controls, toggle contact preferences.
- [ ] History, My entries, My wins: all reflect what you did.
- [ ] Sound: mute from the dashboard or profile; reload and confirm it stays muted.
- [ ] Demo controls → "Refresh the Naira rate now": prices show "Refreshing rate", then a new number.
- [ ] Staging URL shows the STAGING badge; production does not.

The demo database lives in `localStorage` (`raffwin.demo.db.v1`). "Reset demo data" in Profile → Demo
controls re-seeds the raffles relative to the current time (so countdowns are live again) and keeps
your account. "Sign out and start over" clears everything.

---

## 8. Project structure

```
src/
  app/            App root, Telegram gate, hash router, route guards
  components/     ui primitives (BouncyButton, AnimatedNumber, TiltCard, Sheet, Countdown,
                  ProgressBar, Field/Stepper/Toggle, PrizeArt, Sparkline, Toast, StagingBadge ...)
                  layout (AppShell, TabBar), shared motion variants
  features/
    splash/       animated intro
    auth/         sign up
    onboarding/   welcome, how it works, rules (+ demo rules text)
    dashboard/    analytics, next draw
    raffles/      swipe deck, ticket card, detail sheet, enter flow, draw reveal
    wallet/       packages, order summary, demo card payment
    profile/      sections, history, entries, wins, demo controls
  services/       rates.ts (the ONLY Naira/Raffs conversion), sound.ts (Web Audio), haptics.ts,
                  telegram.ts (bridge wrapper), env.ts, format.ts, validation.ts, confetti.ts
  api/            mock endpoints with artificial delays + the localStorage demo database
  store/          Zustand store (settings persisted) and derived hooks
  data/           types, seed data, raffle status rules, Nigerian states
  hooks/          useNow, useCountdown, useRate, useRateLifecycle, useBackButton, image helper
  styles/         tokens.css (design tokens for Tailwind v4), globals.css
bot/              grammY bot: src/bot.ts (commands), polling.ts, server.ts (webhook), api/webhook.ts (Vercel)
.github/          ci.yml (typecheck/lint/build), pages.yml (deploy both environments)
```

---

## 9. Swapping in the real backend

- **API**: `src/api/index.ts` is the only module the store talks to. Re-implement each function with
  `fetch()` against the real endpoints, keep the request/response shapes from `src/data/types.ts`,
  and delete `src/api/db.ts`. Errors should throw `ApiError` with the same codes so the UI copy keeps
  working (`INSUFFICIENT_FUNDS`, `RAFFLE_CLOSED`, `RATE_EXPIRED`, `PAYMENT_DECLINED`, ...).
- **Rates**: implement `RateProvider` in `src/services/rates.ts` against the real conversion table
  and call `setRateProvider(...)` on boot. All Raffs amounts in the UI already flow through
  `entryCostRaffs`, `nairaToRaffs` and `raffsToNaira`; nothing else converts.
- **Auth**: pass `window.Telegram.WebApp.initData` to the backend for validation; the UI already reads
  the Telegram user to pre-fill sign-up.
- **Payments**: replace `DemoCardSheet` with the provider's checkout; `buyRaffs` keeps its signature.

---

## 10. Decisions made in demo

- **Rate convention**: the quote is *Naira per 1 Raff* (base ₦10, ±3-5% per hour). Quotes are aligned
  to the clock hour and derived deterministically from the hour index, so a reload inside the same
  hour shows the same rate and an honest expiry countdown. Purchases round Raffs down, entry costs
  round up.
- **Hash routing + base path** so the app works on GitHub Pages without rewrites. Both environments
  live on one Pages site (`/` and `/staging/`), rebuilt together by one workflow.
- **Demo seed on sign-up**: a new account receives a welcome bonus, an old entry that came 3rd in a
  drawn raffle (so "My wins" and the "Raffles won" tile have content) and two tickets in the
  "Drawing now" raffle. Every seeded transaction is labelled "(demo seed)".
- **Demo draw rule**: winners are random from the demo entrants; if the signed-in user entered, they
  are guaranteed one of the three slots so the win celebration can be demonstrated. Raffs-credit
  prizes are paid into the balance immediately.
- **Raffle status** is derived from the deadline at read time (open → closing soon under 24 h →
  drawing once the deadline passes → drawn after the reveal), so cards change state live.
- **Deck order**: live raffles by soonest deadline, then drawing/drawn by most recent deadline, so a
  card does not jump when its draw completes.
- **Entry cap** of 50 tickets per confirmation (and never more than the remaining pool).
- **Service fee** of 1.5% on purchases, clearly marked as demo.
- **Images** are generated SVG illustrations per prize type (no image files); ID and selfie uploads
  are downscaled to about 480 px JPEG and kept in localStorage only.
- **Telegram**: `ready()`, `expand()`, header/background colours, `disableVerticalSwipes` (so a drag
  on the deck does not minimise the app) and the native BackButton on sub-screens. The MainButton is
  not used; in-app buttons carry the brand look.
- **Bot** uses grammY with no storage; `/start`, `/help`, `/rules` plus a fallback reply, long polling
  for local runs and a webhook server (or Vercel function) for hosting.
- **Authorship**: the maker footer appears on the sign-up page only, and an "About this software" card
  sits at the bottom of Profile. Nothing else inside the app carries the maker's name.
