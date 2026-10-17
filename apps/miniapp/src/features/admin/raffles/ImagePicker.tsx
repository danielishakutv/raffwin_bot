/**
 * The raffle photo: upload one, or import one from an https link. Either way
 * it is re-encoded on this phone to under 500 KB and stored on the API, so
 * players never download a heavy or hotlinked image.
 */
import { useRef, useState } from 'react'
import { ImagePlus, Link2, Trash2, Upload } from 'lucide-react'
import { errorMessage } from '@/api/errors'
import { PrizeVisual } from '@/components/ui/PrizeVisual'
import { shrinkPhoto } from '@/services/media'
import { adminFetchBlob, adminUpload } from '../adminSession'
import { Button, Field, Notice, Segmented, TextInput } from '../ui'
import type { PrizeKind } from './draft'

interface Uploaded {
  id: string
  url: string
  sizeBytes: number
  width: number | null
  height: number | null
}

type Mode = 'upload' | 'link'
type Status = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; text: string }

export function ImagePicker({ value, onChange, kind, hue }: { value: string | null; onChange: (url: string | null) => void; kind: PrizeKind; hue: number }) {
  const [mode, setMode] = useState<Mode>('upload')
  const [link, setLink] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)
  const working = status.kind === 'working'

  const kb = (n: number) => `${Math.max(1, Math.round(n / 1000))} KB`

  /** Shrink under 500 KB, upload, and use the stored copy. */
  const store = async (original: Blob, from: string) => {
    setStatus({ kind: 'working', text: `Optimising ${kb(original.size)}...` })
    const { blob, width, height } = await shrinkPhoto(original)
    setStatus({ kind: 'working', text: `Uploading ${kb(blob.size)}...` })
    const res = await adminUpload<Uploaded>('/media', blob)
    onChange(res.url)
    setStatus({
      kind: 'done',
      text: `${from}: ${width} x ${height}, ${kb(original.size)} optimised to ${kb(res.sizeBytes)}.${width < 500 && height < 500 ? ' It is small, so it may look soft on large phones.' : ''} Save the raffle to keep it.`,
    })
  }

  const upload = async (file: File) => {
    try {
      await store(file, 'Uploaded')
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    }
  }

  const importLink = async () => {
    const url = link.trim()
    if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) {
      setStatus({ kind: 'error', text: 'Use a full address that starts with https://' })
      return
    }
    try {
      setStatus({ kind: 'working', text: 'Fetching the image...' })
      const original = await adminFetchBlob('/media/fetch', { url })
      await store(original, 'Imported')
      setLink('')
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[132px_minmax(0,1fr)]">
      <div
        className="relative mx-auto aspect-square w-[132px] overflow-hidden rounded-xl ring-1 ring-black/15"
        style={{ backgroundImage: `linear-gradient(150deg, hsl(${hue} 80% 48%) 0%, hsl(${(hue + 45) % 360} 85% 42%) 100%)` }}
      >
        <PrizeVisual key={value ?? 'none'} kind={kind} hue={hue} imageUrl={value} rounded="rounded-none" className="h-full w-full" />
        {!value && <span className="absolute inset-x-0 bottom-0 bg-black/55 py-1 text-center text-[10.5px] font-semibold text-white">Illustration</span>}
        {working && (
          <span className="admin-fade absolute inset-0 flex items-center justify-center bg-white/70">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-black border-t-transparent" />
          </span>
        )}
      </div>

      <div className="grid min-w-0 content-start gap-3">
        <Segmented<Mode>
          size="sm"
          value={mode}
          onChange={(m) => {
            setMode(m)
            setStatus({ kind: 'idle' })
          }}
          options={[
            { value: 'upload', label: <><Upload size={13} /> Upload</> },
            { value: 'link', label: <><Link2 size={13} /> Image link</> },
          ]}
        />

        {mode === 'upload' ? (
          <div className="admin-in grid gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void upload(file)
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="solid" icon={<ImagePlus size={15} />} disabled={working} onClick={() => fileRef.current?.click()}>
                {value ? 'Replace photo' : 'Choose photo'}
              </Button>
              {value && (
                <Button variant="ghost" icon={<Trash2 size={15} />} disabled={working} onClick={() => (onChange(null), setStatus({ kind: 'idle' }))}>
                  Remove
                </Button>
              )}
            </div>
            <p className="text-[11.5px] leading-snug text-neutral-500">
              A clear photo of the prize on a plain background works best. Any size is fine: it is optimised to under 500 KB on this phone before upload.
            </p>
          </div>
        ) : (
          <div className="admin-in grid gap-2">
            <Field label="Image address" hint="Starts with https:// and opens as the picture on its own (long-press an image, then Copy image address).">
              <TextInput
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://example.com/prize.jpg"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void importLink()
                  }
                }}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="solid" disabled={working || !link.trim()} onClick={() => void importLink()}>
                Import image
              </Button>
              {value && (
                <Button variant="ghost" icon={<Trash2 size={15} />} disabled={working} onClick={() => (onChange(null), setStatus({ kind: 'idle' }))}>
                  Remove
                </Button>
              )}
            </div>
            <p className="text-[11.5px] leading-snug text-neutral-500">
              The image is copied once, optimised to under 500 KB and stored here, so it keeps working even if that site removes it.
            </p>
          </div>
        )}

        {status.kind === 'working' && <p className="admin-fade text-[12.5px] font-semibold text-neutral-700">{status.text}</p>}
        {status.kind === 'done' && <Notice tone="success">{status.text}</Notice>}
        {status.kind === 'error' && <Notice tone="error">{status.text}</Notice>}
        {value && status.kind === 'idle' && <p className="text-[11.5px] text-neutral-500">A stored photo is in use. Players see it instead of the illustration.</p>}
      </div>
    </div>
  )
}
