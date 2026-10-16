# Notes for Daniel - what was built, what to check, how to deploy and test

Everything in the brief is built, typechecked, linted, built, committed and deployed. This page is the
short version; the README has the full detail.

## Where things are

- Code: `C:\Users\USER\Desktop\raffwin_bot` (clone of https://github.com/danielishakutv/raffwin_bot)
- Branches: `main` (production) and `staging` (staging). Both are pushed.
- Live production: https://danielishakutv.github.io/raffwin_bot/
- Live staging: https://danielishakutv.github.io/raffwin_bot/staging/ (shows the STAGING badge)
- GitHub Pages is already switched on (Settings → Pages → Source: GitHub Actions). Every push to
  `main` or `staging` redeploys both. Watch it under the repository's **Actions** tab.

Opening either live URL in a normal browser shows the "Open Raffle Win in Telegram" gate. That is
correct: the app only runs inside Telegram. To try it in a browser, run it locally:

```bash
cd C:\Users\USER\Desktop\raffwin_bot
npm install
npm run dev        # then open http://localhost:5173
```

## Connect the Telegram bot (5 minutes, BotFather only)

1. Open @BotFather → `/setmenubutton` → choose `@raffwin_bot` → paste
   `https://danielishakutv.github.io/raffwin_bot/` → title `Open Raffle Win`.
2. (Optional) `/newapp` → `@raffwin_bot` → title, description, 640x360 image, same URL, short name `app`.
   Direct link becomes https://t.me/raffwin_bot/app.
3. Open https://t.me/raffwin_bot, press Start, tap the menu button. The app loads inside Telegram.

For staging, create a test bot (`/newbot` → `raffwin_test_bot`) and repeat step 1 with the staging URL.
If you pick a different username, change `VITE_BOT_USERNAME` in `.env.staging` and push.

The `/start`, `/help` and `/rules` replies with the inline "Open Raffle Win" button need the bot
process running. Locally: copy `bot/.env.example` to `bot/.env`, put your BOT_TOKEN in it, then
`npm run bot`. Hosting options (Render / Railway / Vercel) are in README section 6.

## What to test tomorrow (all verified working in the browser tonight)

1. Sign up → onboarding (swipe the three steps, tick the box) → dashboard.
2. Raffles tab: swipe the deck, tap a card, "Enter raffle", change quantity, confirm. Confetti, chime,
   balance down, entries up.
3. The "Infinix Hot 50" card is in "Drawing now": open it, tap "Reveal the winners". Drumroll, winners
   land 3rd → 2nd → 1st, and you win 3rd place (demo rule: if you entered, you always get a slot).
4. Wallet: pick a package, "Pay with card", type any numbers, pay. Then try again with
   "Simulate a declined card" on.
5. Profile: edit info, add address, upload an ID + selfie, toggle contact prefs, flip the verification
   outcome under "Demo controls", check History / My entries / My wins.
6. Mute from the dashboard speaker icon; reload; it stays muted.
7. The yellow rate chip counts down to the top of the hour; when it hits zero every Raffs price shows
   "Refreshing rate" for a second, then the new rate appears. "Refresh the Naira rate now" in Demo
   controls forces it.

If the demo data gets messy: Profile → Demo controls → "Reset demo data" (keeps your account) or
"Sign out and start over" (clears everything). Data lives only in the browser's localStorage.

## Things to know

- The deadlines are seeded relative to the moment the demo data is first created, so the countdowns
  are live. After about 7 days all raffles will have passed; use "Reset demo data" to re-seed.
- No secrets anywhere in the repo. `bot/.env` is git-ignored.
- Decisions I made where the brief was open are listed at the end of the README.
