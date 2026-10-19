#!/usr/bin/env node
/**
 * The separation rule (19 Oct), checked mechanically:
 *
 *   the sales site (apps/buy-web, apps/buy-api: sources and builds) never
 *   names the game's domains or bot, and the game (apps/miniapp, apps/api:
 *   sources and builds) never names the sales site.
 *
 * Exits 1 with every hit as file:line. Runs on every sales-site build and as
 * a test. Real host names are added at deploy time without writing them into
 * this repository's sales code:
 *
 *   SEPARATION_GAME_HOSTS=game.example.com,test.game.example.com
 *   SEPARATION_SALES_HOSTS=buy.example.ng,buytest.example.ng
 *
 * Usage: node scripts/check-separation.mjs [--sources-only]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourcesOnly = process.argv.includes('--sources-only')
const extra = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((h) => new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))

// What the sales site must never contain: the game's hosts and bot
const GAME = [/toko\.com\.ng/i, /raffwin(?:test)?\.[a-z]/i, /raffwin_bot/i, /t\.me\/raffwin/i, ...extra('SEPARATION_GAME_HOSTS')]
// What the game must never contain: the sales site
const SALES = [/instaplay/i, ...extra('SEPARATION_SALES_HOSTS')]

const SALES_DIRS = ['apps/buy-web/src', 'apps/buy-web/index.html', 'apps/buy-web/public', 'apps/buy-api/src', ...(sourcesOnly ? [] : ['apps/buy-web/dist', 'apps/buy-api/dist'])]
const GAME_DIRS = ['apps/miniapp/src', 'apps/miniapp/index.html', 'apps/miniapp/public', 'apps/api/src', ...(sourcesOnly ? [] : ['apps/miniapp/dist', 'apps/api/dist'])]
const TEXT = /\.(?:[cm]?[jt]sx?|html|css|json|svg|txt|webmanifest|map)$/

function* files(path) {
  if (!existsSync(path)) return
  const st = statSync(path)
  if (st.isFile()) {
    if (TEXT.test(path)) yield path
    return
  }
  for (const name of readdirSync(path)) {
    if (name === 'node_modules') continue
    yield* files(join(path, name))
  }
}

function scan(dirs, patterns, what) {
  const hits = []
  for (const dir of dirs) {
    for (const file of files(join(root, dir))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const p of patterns) if (p.test(line)) hits.push(`${relative(root, file)}:${i + 1}  ${what}: ${p}`)
      })
    }
  }
  return hits
}

const hits = [...scan(SALES_DIRS, GAME, 'the sales site names the game'), ...scan(GAME_DIRS, SALES, 'the game names the sales site')]
if (hits.length) {
  console.error(`Separation check failed (${hits.length}):\n${hits.join('\n')}`)
  process.exit(1)
}
console.log(`Separation check passed${sourcesOnly ? ' (sources)' : ''}.`)
