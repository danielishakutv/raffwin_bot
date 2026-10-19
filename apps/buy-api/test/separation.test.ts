/**
 * The separation rule on every test run: the sales site's sources never name
 * the game, and the game's never name the sales site (scripts/check-separation.mjs;
 * builds are checked again at build time).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/check-separation.mjs', import.meta.url))

describe('separation', () => {
  it('the sales site and the game do not name each other', () => {
    const run = spawnSync(process.execPath, [script, '--sources-only'], { encoding: 'utf8', env: { ...process.env, SEPARATION_GAME_HOSTS: '', SEPARATION_SALES_HOSTS: '' } })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('would fail on a forbidden host', () => {
    const run = spawnSync(process.execPath, [script, '--sources-only'], { encoding: 'utf8', env: { ...process.env, SEPARATION_GAME_HOSTS: 'api.paystack.co' } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('apps')
  })
})
