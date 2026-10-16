/**
 * Local development data. Refuses to run unless NODE_ENV=development, so it
 * can never put invented raffles or free Raffs into staging or production.
 *
 *   pnpm --filter @raffwin/api dev:seed                          three open raffles (if none are open)
 *   pnpm --filter @raffwin/api dev:seed --credit 900000001 5000  give a Telegram id 5000 test Raffs
 */
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { rafflePrizes, raffles, users } from '../db/schema'
import { post } from '../services/ledger'

const DAY = 86_400_000

const SAMPLES = [
  { prizeName: 'Samsung Galaxy A15', model: '8GB RAM, 256GB', category: 'Phones', kind: 'phone', hue: 265, marketPriceNaira: 185_000, entryPriceRaffs: 50, entriesTarget: 500, days: 3 },
  { prizeName: 'Oraimo FreePods 4', model: 'ANC, wireless case', category: 'Audio', kind: 'earbuds', hue: 160, marketPriceNaira: 28_500, entryPriceRaffs: 10, entriesTarget: 400, days: 1 },
  { prizeName: 'HP 15 Laptop', model: 'Core i5, 16GB, 512GB SSD', category: 'Laptops', kind: 'laptop', hue: 210, marketPriceNaira: 650_000, entryPriceRaffs: 100, entriesTarget: 650, days: 7 },
] as const

async function main() {
  const config = loadConfig()
  if (config.NODE_ENV !== 'development') {
    console.error(`dev:seed only runs with NODE_ENV=development (this is ${config.NODE_ENV}).`)
    process.exit(2)
  }
  const { values } = parseArgs({ options: { credit: { type: 'string', multiple: true } }, allowPositionals: true, strict: false })
  const handle = createDb(config.DATABASE_URL, { max: 1 })
  try {
    const credit = (values.credit as string[] | undefined) ?? []
    if (credit.length) {
      const [tgId, amount] = [Number(process.argv.at(-2)), Number(process.argv.at(-1))]
      const [user] = await handle.db.select().from(users).where(eq(users.telegramId, tgId))
      if (!user || !Number.isInteger(amount) || amount <= 0) {
        console.error('usage: dev:seed --credit <telegramId> <raffs>  (the user must have opened the app once)')
        process.exit(2)
      }
      const row = await handle.db.transaction((tx) => post(tx, { userId: user.id, type: 'adjustment', raffs: amount, note: 'Development test credit' }))
      console.log(`credited ${amount} Raffs to telegram ${tgId}; balance now ${row.balanceAfter}`)
      return
    }
    const open = await handle.db.select({ id: raffles.id }).from(raffles).where(eq(raffles.status, 'open'))
    if (open.length) {
      console.log(`${open.length} open raffle(s) already; nothing added`)
      return
    }
    for (const s of SAMPLES) {
      const { days, ...fields } = s
      await handle.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(raffles)
          .values({
            ...fields,
            slug: `dev-${s.kind}-${Date.now().toString(36)}`,
            deadline: new Date(Date.now() + days * DAY),
            status: 'open',
            openedAt: new Date(),
            description: 'Development sample raffle.',
            rules: ['One draw, three winners.'],
          })
          .returning({ id: raffles.id })
        if (!row) throw new Error('raffle insert returned no row')
        await tx.insert(rafflePrizes).values([
          { raffleId: row.id, position: 1, prizeItem: s.prizeName, prizeType: 'physical' },
          { raffleId: row.id, position: 2, prizeItem: '2,000 Raffs credit', prizeType: 'raffs_credit', raffsValue: 2000 },
          { raffleId: row.id, position: 3, prizeItem: '500 Raffs credit', prizeType: 'raffs_credit', raffsValue: 500 },
        ])
      })
      console.log(`opened ${s.prizeName}`)
    }
  } finally {
    await handle.close()
  }
}

main().catch((error: unknown) => {
  console.error('dev:seed failed:', error)
  process.exit(1)
})
