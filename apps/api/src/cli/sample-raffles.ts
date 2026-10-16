/**
 * Opens three sample raffles on the TEST environment so the app has something
 * to show. Refuses to run with NODE_ENV=production. Goes through the same
 * admin operations as the admin screen (validated, audit-logged as the system).
 *
 *   node --env-file=.env dist/sample-raffles.js        (on the server, test env only)
 */
import { pino } from 'pino'
import { raffleBody } from '@raffwin/shared/admin-schemas'
import { createRaffle, openRaffle } from '../admin/operations'
import { loadConfig } from '../config'
import type { AppContext } from '../context'
import { createDb } from '../db/client'
import { AccessTokens } from '../lib/access-token'

const DAY = 86_400_000

const SAMPLES = [
  { prizeName: 'Samsung Galaxy A15', model: '8GB RAM, 256GB', category: 'Phones', kind: 'phone', hue: 265, marketPriceNaira: 185_000, entryPriceRaffs: 50, entriesTarget: 500, days: 3, p2: '2,000 Raffs credit', p2r: 2000, p3: '500 Raffs credit', p3r: 500 },
  { prizeName: 'Oraimo FreePods 4', model: 'ANC, wireless charging case', category: 'Audio', kind: 'earbuds', hue: 160, marketPriceNaira: 28_500, entryPriceRaffs: 10, entriesTarget: 400, days: 1, p2: '500 Raffs credit', p2r: 500, p3: '200 Raffs credit', p3r: 200 },
  { prizeName: 'HP 15 Laptop', model: 'Core i5, 16GB, 512GB SSD', category: 'Laptops', kind: 'laptop', hue: 210, marketPriceNaira: 650_000, entryPriceRaffs: 100, entriesTarget: 650, days: 7, p2: '5,000 Raffs credit', p2r: 5000, p3: '1,000 Raffs credit', p3r: 1000 },
] as const

async function main() {
  const config = loadConfig()
  if (config.NODE_ENV === 'production') {
    console.error('sample-raffles refuses to run in production.')
    process.exit(2)
  }
  const handle = createDb(config.DATABASE_URL, { max: 2 })
  const ctx: AppContext = {
    config,
    db: handle.db,
    log: pino({ level: 'warn' }),
    tokens: new AccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
    now: Date.now,
  }
  try {
    for (const s of SAMPLES) {
      const body = raffleBody.parse({
        prizeName: s.prizeName,
        model: s.model,
        category: s.category,
        kind: s.kind,
        hue: s.hue,
        marketPriceNaira: s.marketPriceNaira,
        entryPriceRaffs: s.entryPriceRaffs,
        entriesTarget: s.entriesTarget,
        deadline: new Date(Date.now() + s.days * DAY).toISOString(),
        description: 'Test-environment sample raffle. No real prize.',
        rules: ['Test environment: nothing here is real money or a real prize.'],
        prizes: [
          { position: 1, prizeItem: s.prizeName, prizeType: 'physical' },
          { position: 2, prizeItem: s.p2, prizeType: 'raffs_credit', raffsValue: s.p2r },
          { position: 3, prizeItem: s.p3, prizeType: 'raffs_credit', raffsValue: s.p3r },
        ],
      })
      const draft = await createRaffle(ctx, null, body)
      const opened = await openRaffle(ctx, null, draft.id)
      console.log(`opened ${opened.prizeName}: ${opened.entryPriceRaffs} Raffs x ${opened.entriesTarget}, draw ${opened.deadline}`)
    }
  } finally {
    await handle.close()
  }
}

main().catch((error: unknown) => {
  console.error('sample-raffles failed:', error)
  process.exit(1)
})
