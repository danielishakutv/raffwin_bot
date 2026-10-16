/**
 * Loads bot/.env into process.env for local runs (no dependency needed).
 * Hosted environments inject variables directly, so a missing file is fine.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadDotEnv(file = resolve(process.cwd(), '.env')): void {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
