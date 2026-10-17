/**
 * What the bot says when it reminds or invites a player back.
 *
 * The reminder pool (keys r01..) is chosen from so that a player never gets
 * the same text twice within 48 hours (services/engagement.ts). Rules for the
 * texts, so the pool stays something a player is glad to receive:
 *   - short and warm, the way a friend in Lagos would say it;
 *   - honest: no fake urgency, no "last chance", no hint that anyone will win
 *     or has won, no pressure to spend;
 *   - no "tap below": the open button is missing when the server has no app URL;
 *   - nothing that depends on a feature that can be switched off (streaks,
 *     transfers), and no figures that could go stale.
 * `{name}` is replaced with the player's first name, HTML-escaped. The texts
 * themselves contain no markup characters, so they are valid Telegram HTML.
 * The admin's Messages tab lists this pool as it is.
 */
import { escapeHtml } from '../lib/html'

export const REMINDER_TEXTS: { key: string; text: string }[] = [
  { key: 'r01', text: 'Hi {name}, new raffles may have opened since you last looked. Have a quick look when you have a minute.' },
  { key: 'r02', text: '{name}, how far? Every raffle ends with a live draw, and the winners are real people like you. See what is open now.' },
  { key: 'r03', text: 'Hello {name}. Your entries and the results of finished draws are all in the app, any time you want to check.' },
  { key: 'r04', text: 'Draws on Raffle Win happen live, {name}. You can watch one from start to finish and see exactly how the winners are picked.' },
  { key: 'r05', text: '{name}, a friend of yours could be the next winner. Share your invite link from the app, and you earn Raffs each time they enter.' },
  { key: 'r06', text: 'Quick one, {name}: phones, laptops, TVs and more are on Raffle Win. See which raffles are open right now.' },
  { key: 'r07', text: 'Hello {name}! Every raffle shows its prizes, entry price and deadline up front. No surprises. Take a look when you are free.' },
  { key: 'r08', text: '{name}, it has been a few hours. Nothing urgent, just checking in. The raffles are there whenever you are ready.' },
  { key: 'r09', text: 'Hi {name}, the results of finished draws are in the app. See who won and how each draw went.' },
  { key: 'r10', text: '{name}, small small: one entry is all it takes to be in a draw. Pick a raffle you like, no pressure.' },
  { key: 'r11', text: 'Hope your day is going well, {name}. When you have a short break, see what is new on Raffle Win.' },
  { key: 'r12', text: 'Your Raffle Win wallet is one tap away, {name}. Check your Raffs balance and history whenever you like.' },
  { key: 'r13', text: '{name}, we add new raffles from time to time. Have a look, so you see the ones you like while they are open.' },
  { key: 'r14', text: 'Hi {name}! Prizes are delivered to a motor park near the winner, so nobody travels far. See the prizes on offer now.' },
  { key: 'r15', text: '{name}, how body? Just a friendly hello from Raffle Win. Open the app whenever you want to look around.' },
  { key: 'r16', text: 'Play for fun, {name}, and only with Raffs you are happy to spend. The current raffles are in the app whenever you want them.' },
  { key: 'r17', text: 'Hello {name}, each raffle page lists every prize, 1st, 2nd and beyond, and how many winners it will have. Worth a look.' },
  { key: 'r18', text: '{name}, if you know someone who would like a new phone or TV, send them your invite link from the app. They can join in a few seconds.' },
]

const BY_KEY = new Map(REMINDER_TEXTS.map((t) => [t.key, t.text]))

/** Fills `{name}` (escaped) into a pool text. Throws on an unknown key: a programming error, not a player's. */
export function renderReminder(key: string, name: string): string {
  const text = BY_KEY.get(key)
  if (text === undefined) throw new Error(`unknown reminder text ${key}`)
  return text.replaceAll('{name}', escapeHtml(name))
}

/** The come-back offer: one message, the exact credit and how long it stays open. */
export function comebackText(name: string, raffs: number, days: number): string {
  const credit = raffs === 1 ? '1 free Raff' : `${raffs} free Raffs`
  return `We miss you, ${escapeHtml(name)}! Open Raffle Win in the next ${days} days and we will add ${credit} to your balance.`
}

/** Callback data on the button under reminders and offers (handled in bot/engagement-bot.ts) */
export const REMINDERS_OFF = 'reminders:off'
export const REMINDERS_ON = 'reminders:on'
export const TURN_OFF_LABEL = 'Turn off reminders'
export const TURN_ON_LABEL = 'Turn reminders back on'
