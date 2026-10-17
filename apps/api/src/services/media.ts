/**
 * Raffle photos uploaded by admins. The Mini App re-encodes every photo to
 * under 500 KB before it sends it, and the API refuses anything larger; they are stored in the
 * database and served publicly, because players' <img> tags carry no token.
 */
import { createHash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { eq } from 'drizzle-orm'
import { MEDIA_FETCH_MAX_BYTES, MEDIA_MAX_BYTES, MEDIA_TYPES } from '@raffwin/shared/admin-schemas'
import type { AppContext } from '../context'
import { media } from '../db/schema'
import { HttpError } from '../lib/http-error'
import { appendAudit } from '../admin/audit'

export type MediaType = (typeof MEDIA_TYPES)[number]

/** What the bytes actually are, from their signature; the declared type is not trusted. */
export function sniff(bytes: Buffer): MediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** Width and height from the file header, where the format makes that cheap; otherwise null. */
function dimensions(type: MediaType, b: Buffer): { width: number | null; height: number | null } {
  try {
    if (type === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    if (type === 'image/webp') {
      const chunk = b.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
    if (type === 'image/jpeg') {
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) break
        const marker = b[i + 1] as number
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
        }
        i += 2 + b.readUInt16BE(i + 2)
      }
    }
  } catch {
    // A truncated header: the image is still stored, just without its size
  }
  return { width: null, height: null }
}

export interface StoredMedia {
  id: string
  url: string
  mime: MediaType
  sizeBytes: number
  width: number | null
  height: number | null
}

export async function storeUpload(ctx: AppContext, adminId: string, body: unknown): Promise<StoredMedia> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError('INVALID_INPUT', 'Send the photo as JPEG, PNG or WebP.')
  }
  if (body.length > MEDIA_MAX_BYTES) {
    throw new HttpError('INVALID_INPUT', `That photo is too large (at most ${Math.round(MEDIA_MAX_BYTES / 1000)} KB).`)
  }
  const mime = sniff(body)
  if (!mime) throw new HttpError('INVALID_INPUT', 'That file is not a JPEG, PNG or WebP photo.')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const { width, height } = dimensions(mime, body)

  const row = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: media.id }).from(media).where(eq(media.sha256, sha256))
    if (existing) return { id: existing.id, reused: true }
    const [inserted] = await tx
      .insert(media)
      .values({ mime, bytes: body, sizeBytes: body.length, width, height, sha256, createdByAdminId: adminId })
      .onConflictDoNothing({ target: media.sha256 })
      .returning({ id: media.id })
    // Lost a race with the same file: use the one that won
    const id = inserted?.id ?? (await tx.select({ id: media.id }).from(media).where(eq(media.sha256, sha256)))[0]?.id
    if (!id) throw new Error('media insert returned no row')
    await appendAudit(tx, { adminId, action: 'media.upload', targetType: 'media', targetId: id, after: { mime, sizeBytes: body.length, width, height, sha256 } })
    return { id, reused: false }
  })
  return { id: row.id, url: `/v1/media/${row.id}`, mime, sizeBytes: body.length, width, height }
}

export async function readMedia(ctx: AppContext, id: string): Promise<{ mime: string; bytes: Buffer; sha256: string } | null> {
  const [row] = await ctx.db.select({ mime: media.mime, bytes: media.bytes, sha256: media.sha256 }).from(media).where(eq(media.id, id))
  return row ?? null
}

/* Importing from a link -------------------------------------------------------- */

/**
 * True for addresses an admin-triggered fetch must never reach: loopback,
 * private ranges, link-local (cloud metadata), CGNAT, multicast, unspecified.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  const g = ipv6Groups(address)
  // Not a parseable address: refuse rather than guess
  if (!g) return true
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  // Addresses that carry an IPv4 address inside are judged by that address:
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, also :: and ::1), 64:ff9b::/96 (NAT64), 2002::/16 (6to4)
  if (zeros(5) && g[5] === 0xffff) return isBlockedAddress(v4(g[6] as number, g[7] as number))
  if (zeros(6)) return true
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedAddress(v4(g[6] as number, g[7] as number))
  if (g[0] === 0x2002) return isBlockedAddress(v4(g[1] as number, g[2] as number))
  const first = g[0] as number
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 old site-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    (first === 0x2001 && g[1] === 0x0db8) || // documentation
    (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) // 100::/64 discard
  )
}

/** The eight 16-bit groups of an IPv6 address (any notation, including an IPv4 tail and a %zone), or null. */
export function ipv6Groups(address: string): number[] | null {
  const a = address.toLowerCase().replace(/%.*$/, '')
  if (isIP(a) !== 6) return null
  let text = a
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (tail?.[1]) {
    const [p, q, r, s] = tail[1].split('.').map(Number) as [number, number, number, number]
    text = `${a.slice(0, -tail[1].length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest !== undefined && rest !== '' ? rest.split(':') : []
  const missing = 8 - left.length - right.length
  if (rest === undefined ? missing !== 0 : missing < 1) return null
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right].map((x) => parseInt(x, 16))
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null
}

/** Resolves like the default lookup, but refuses blocked addresses at connect time (no DNS-rebinding gap). */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as LookupAddress[]
    const bad = list.find((a) => isBlockedAddress(a.address))
    if (bad || list.length === 0) return callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }), '', 0)
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
    const first = list[0] as LookupAddress
    callback(null, first.address, first.family)
  })
}

const FETCH_TIMEOUT_MS = 12_000

/**
 * Downloads an image from an https link for the admin app to shrink and
 * upload. Admin-only. Follows up to three redirects, each re-checked.
 */
export async function fetchRemoteImage(rawUrl: string, redirects = 3): Promise<{ mime: string; bytes: Buffer }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new HttpError('INVALID_INPUT', 'That is not a web address.')
  }
  if (url.protocol !== 'https:') throw new HttpError('INVALID_INPUT', 'Use an address that starts with https://')
  if (url.port && url.port !== '443') throw new HttpError('INVALID_INPUT', 'Only standard https addresses (port 443) can be imported.')
  if (url.username || url.password) throw new HttpError('INVALID_INPUT', 'Addresses with a user name or password cannot be imported.')
  // Node connects to an IP literal without calling lookup, so the guard must see it here
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw new HttpError('INVALID_INPUT', 'That address points inside a private network and cannot be imported.')
  }

  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpsGet(
      url,
      { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 'user-agent': 'RaffleWinImageImport/1.0' } },
      resolve,
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
  }).catch((error: { code?: string }) => {
    if (error.code === 'EBLOCKED') throw new HttpError('INVALID_INPUT', 'That address points inside a private network and cannot be imported.')
    if (error.code === 'ETIMEDOUT') throw new HttpError('INVALID_INPUT', 'That site took too long to answer.')
    throw new HttpError('INVALID_INPUT', `Could not reach that site (${error.code ?? 'network error'}).`)
  })

  const status = res.statusCode ?? 0
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume()
    if (redirects <= 0) throw new HttpError('INVALID_INPUT', 'That address redirects too many times.')
    return fetchRemoteImage(new URL(res.headers.location, url).toString(), redirects - 1)
  }
  if (status !== 200) {
    res.resume()
    throw new HttpError('INVALID_INPUT', `That site answered HTTP ${status} instead of an image.`)
  }
  const type = String(res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type.startsWith('image/') || type === 'image/svg+xml') {
    res.resume()
    throw new HttpError('INVALID_INPUT', type ? `That address is ${type}, not a photo. Copy the address of the image itself.` : 'That address did not say it is an image.')
  }
  const declared = Number(res.headers['content-length'] ?? 0)
  if (declared > MEDIA_FETCH_MAX_BYTES) {
    res.destroy()
    throw new HttpError('INVALID_INPUT', `That image is ${Math.round(declared / 1_000_000)} MB; at most ${MEDIA_FETCH_MAX_BYTES / 1_000_000} MB can be imported.`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MEDIA_FETCH_MAX_BYTES) {
      res.destroy()
      throw new HttpError('INVALID_INPUT', `That image is larger than ${MEDIA_FETCH_MAX_BYTES / 1_000_000} MB.`)
    }
    chunks.push(chunk)
  }
  return { mime: type, bytes: Buffer.concat(chunks) }
}
