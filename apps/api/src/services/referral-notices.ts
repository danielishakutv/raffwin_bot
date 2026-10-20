/**
 * Bot messages to a referrer about the people they brought in: when someone
 * joins with their link (what they can earn), and when that person tops up
 * (the most that top-up can earn them). The referrer earns 10% of what their
 * referral spends on entries (services/entries.ts), never on the top-up itself,
 * so the top-up message says "up to".
 *
 * Queued in the same transaction as what it reports, so a message never goes
 * out for something that did not happen. Off with the "Referral alerts" switch,
 * for everyone or for one referrer.
 */
import { eq } from 'drizzle-orm'
import { REFERRAL_PERCENT, referralEarning } from '@raffwin/shared'
import type { AppContext } from '../context'
import { users } from '../db/schema'
import { escapeHtml } from '../lib/html'
import { publicName } from './draw'
import { isFeatureOn } from './features'
import type { Tx } from './ledger'
import { enqueue, openAppButton } from './notify'

type Db = AppContext['db'] | Tx

const n = (x: number) => x.toLocaleString('en-NG')
/** What spending this much on entries earns the referrer, shown in the join message */
const EXAMPLE_SPEND = 5000

interface Player {
  id: string
  username: string | null
  fullName: string | null
  tgFirstName: string | null
}

/** The referrer, if the bot may message them and the switch is on for them */
async function reachableReferrer(db: Db, referrerId: string): Promise<{ id: string; telegramId: number } | null> {
  const [r] = await db
    .select({ id: users.id, telegramId: users.telegramId, status: users.status, botBlockedAt: users.botBlockedAt })
    .from(users)
    .where(eq(users.id, referrerId))
  if (!r || r.status !== 'active' || r.botBlockedAt) return null
  if (!(await isFeatureOn(db, 'referral_alerts', r.id))) return null
  return { id: r.id, telegramId: r.telegramId }
}

/** "@ada joined with your link": once per referred player */
export async function tellReferrerJoined(ctx: AppContext, db: Db, referrerId: string, joined: Player): Promise<void> {
  const referrer = await reachableReferrer(db, referrerId)
  if (!referrer) return
  const who = escapeHtml(publicName(joined))
  const button = openAppButton(ctx, 'See my referrals', 'referrals')
  await enqueue(db, {
    userId: referrer.id,
    telegramId: referrer.telegramId,
    kind: 'referral',
    templateKey: 'referral_joined',
    text: [
      `<b>${who} joined Raffle Win with your link</b>`,
      '',
      `You get ${REFERRAL_PERCENT}% of every Raff they spend on raffle entries, for as long as they play. If they spend ${n(EXAMPLE_SPEND)} Raffs, you get ${n(referralEarning(EXAMPLE_SPEND))}.`,
    ].join('\n'),
    buttons: button ? [[button]] : null,
    dedupeKey: `referral-joined:${joined.id}`,
  })
}

/** "@ada topped up 2,000 Raffs: up to 200 for you": once per purchase or voucher */
export async function tellReferrerTopUp(ctx: AppContext, tx: Tx, player: Player & { referredByUserId: string | null }, raffs: number, ref: string): Promise<void> {
  if (!player.referredByUserId || raffs <= 0) return
  const referrer = await reachableReferrer(tx, player.referredByUserId)
  if (!referrer) return
  const who = escapeHtml(publicName(player))
  const button = openAppButton(ctx, 'See my referrals', 'referrals')
  await enqueue(tx, {
    userId: referrer.id,
    telegramId: referrer.telegramId,
    kind: 'referral',
    templateKey: 'referral_topup',
    text: [
      `<b>${who} just added ${n(raffs)} Raffs</b>`,
      '',
      `When they spend them on raffle entries, you earn up to ${n(referralEarning(raffs))} Raffs (${REFERRAL_PERCENT}%). It lands in your balance with each entry they make.`,
    ].join('\n'),
    buttons: button ? [[button]] : null,
    dedupeKey: `referral-topup:${ref}`,
  })
}
