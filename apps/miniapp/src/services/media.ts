/**
 * Raffle photos. Every photo players see is an upload stored on the API
 * (/v1/media/<id>), re-encoded on the admin's phone to under 500 KB, so a
 * raffle never costs players more than that on mobile data. Images from a
 * link are fetched through the API and go through the same shrinking.
 */
import { MEDIA_MAX_BYTES } from '@raffwin/shared/admin-schemas'
import { env } from './env'

/** Turns a stored imageUrl into something an <img> can load. */
export function imageSrc(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith('/') ? `${env.apiUrl}${url}` : url
}

/** Aim a little under the hard limit the API enforces */
const TARGET_BYTES = Math.min(480_000, MEDIA_MAX_BYTES - 20_000)
/** Longest side tried first, then smaller until the file fits */
const SIDES = [1600, 1200, 1000, 800, 640]
const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.55]

export interface ShrunkPhoto {
  blob: Blob
  width: number
  height: number
  /** Size of what was chosen, before shrinking */
  originalBytes: number
}

/**
 * Re-encodes a photo to WebP (JPEG where the webview cannot write WebP),
 * stepping quality down and then size down until it is under 480 KB. Always
 * re-encodes, even small files, which also strips location data from phone
 * photos. Throws if it cannot get under the limit.
 */
export async function shrinkPhoto(file: Blob): Promise<ShrunkPhoto> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error(`That file is ${file.type}, not a photo. Use JPEG, PNG or WebP.`)
  }
  const source = await loadBitmap(file)
  const srcW = 'naturalWidth' in source ? source.naturalWidth : source.width
  const srcH = 'naturalHeight' in source ? source.naturalHeight : source.height
  if (!srcW || !srcH) throw new Error('That photo has no size we can read. Try a JPEG or PNG.')
  try {
    let smallest: { blob: Blob; width: number; height: number } | null = null
    // Sizes to try, largest first; a small source is tried once at its own size
    const sides = [...new Set(SIDES.map((s) => Math.min(s, Math.max(srcW, srcH))))]
    for (const side of sides) {
      const scale = side / Math.max(srcW, srcH)
      const width = Math.max(1, Math.round(srcW * scale))
      const height = Math.max(1, Math.round(srcH * scale))
      for (const quality of QUALITIES) {
        const blob = await encode(source, width, height, quality)
        if (!smallest || blob.size < smallest.blob.size) smallest = { blob, width, height }
        if (blob.size <= TARGET_BYTES) return { blob, width, height, originalBytes: file.size }
      }
    }
    throw new Error(
      `This photo would not compress under ${Math.round(TARGET_BYTES / 1000)} KB (best was ${Math.round((smallest?.blob.size ?? 0) / 1000)} KB). Try a simpler photo.`,
    )
  } finally {
    if ('close' in source) source.close()
  }
}

let webpWorks: boolean | null = null

async function encode(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob> {
  if (webpWorks !== false) {
    const webp = await draw(source, width, height, 'image/webp', quality, false)
    // Some webviews quietly hand back PNG when asked for WebP
    webpWorks = !!webp && webp.type === 'image/webp'
    if (webpWorks && webp) return webp
  }
  // JPEG has no transparency: paint white behind cut-out product photos
  const jpeg = await draw(source, width, height, 'image/jpeg', quality, true)
  if (!jpeg) throw new Error('This device could not encode the photo. Try another phone or a computer.')
  return jpeg
}

function draw(source: CanvasImageSource, width: number, height: number, type: string, quality: number, whiteBack: boolean): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This device could not prepare the photo (no canvas).')
  if (whiteBack) {
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, width, height)
  }
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file)
    } catch (error) {
      console.warn('[media] createImageBitmap could not read the file; trying an <img>', error)
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('That photo could not be read. Try a JPEG, PNG or WebP.'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
