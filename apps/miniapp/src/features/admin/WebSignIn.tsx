/**
 * Browser (desktop) sign-in: the same three secrets as the bot sign-in, then
 * a 6-digit code the bot sends to the admin's own Telegram account. A stolen
 * password alone does not open the admin; the code proves the phone is theirs.
 *
 * That full sign-in can trust this browser; a trusted browser then asks for
 * the admin password only (TrustedStep).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, Lock, MessageCircle, ShieldCheck } from 'lucide-react'
import type { AdminWebLoginChallenge } from '@raffwin/shared/admin-types'
import { errorMessage } from '@/api/errors'
import { env } from '@/services/env'
import { useNow } from '@/hooks/useNow'
import { browserDevice, browserDeviceSignIn, forgetBrowserDevice, webLoginStart, webLoginVerify } from './adminSession'
import { Button, Check, Err, Field, Notice, TextInput } from './ui'

export function WebSignIn({ reason }: { reason: string | null }) {
  const [trusted, setTrusted] = useState(browserDevice)
  const [form, setForm] = useState({ master: '', username: '', password: '' })
  const [challenge, setChallenge] = useState<AdminWebLoginChallenge | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!form.master.trim() || !form.username.trim() || !form.password.trim()) {
      setError('Fill in all three: the master password, your username and your password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Spaces around a secret (copy and paste, phone keyboards) are not part of it; the API trims too
      setChallenge(await webLoginStart({ master: form.master.trim(), username: form.username.trim(), password: form.password.trim() }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-auto bg-neutral-50 p-4 font-body text-black antialiased">
      <div className="admin-in w-full max-w-sm rounded-2xl border border-black/15 bg-white p-6 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.5)]">
        <div className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-black text-white">{challenge ? <MessageCircle size={20} /> : <Lock size={20} />}</span>
          <h1 className="mt-4 text-[18px] font-extrabold">Raffle Win admin</h1>
          <p className={env.isProduction ? 'mx-auto mt-2 inline-block rounded-full bg-black px-2.5 py-0.5 text-[11px] font-bold tracking-wide text-white' : 'mx-auto mt-2 inline-block rounded-full border border-black/30 px-2.5 py-0.5 text-[11px] font-bold tracking-wide'}>
            {env.isProduction ? `LIVE · @${env.botUsername}` : `TEST · @${env.botUsername}`}
          </p>
        </div>
        {reason && !challenge && <Notice className="mt-4">{reason}</Notice>}
        {/* A failed "Send a new code" is reported here, above the code step */}
        {challenge && <Err message={error} className="mt-4" />}
        {trusted && !challenge ? (
          <TrustedStep
            name={trusted.name}
            onFull={(forget) => {
              if (forget) forgetBrowserDevice()
              setTrusted(null)
            }}
            onLost={() => setTrusted(null)}
          />
        ) : challenge ? (
          <CodeStep
            challenge={challenge}
            onResend={() => void start()}
            resending={busy}
            onBack={() => {
              setChallenge(null)
              setError(null)
            }}
          />
        ) : (
          <form className="mt-5 grid gap-3" onSubmit={(e) => void start(e)}>
            <Field label="Master password">
              <TextInput type="password" autoComplete="off" value={form.master} onChange={(e) => setForm({ ...form, master: e.target.value })} autoFocus />
            </Field>
            <Field label="Admin username">
              <TextInput autoComplete="username" autoCapitalize="off" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
            <Field label="Password">
              <TextInput type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Err message={error} />
            <Button type="submit" variant="solid" className="mt-1 w-full" busy={busy}>
              Continue
            </Button>
            <p className="text-center text-[12px] leading-snug text-neutral-500">The bot then sends a 6-digit code to your Telegram. Sign in once from the bot in Telegram first if you never have.</p>
          </form>
        )}
      </div>
    </div>
  )
}

/** A trusted browser: the admin password only. Losing the trust (5 wrong tries, revoked, at risk) falls back to the full form. */
function TrustedStep({ name, onFull, onLost }: { name: string; onFull: (forget: boolean) => void; onLost: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setError('Enter your admin password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await browserDeviceSignIn(password.trim())
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
      // The API ended the trust: the full form takes over, with the reason kept above it
      if (!browserDevice()) onLost()
    }
  }
  return (
    <form className="mt-5 grid gap-3" onSubmit={(e) => void submit(e)}>
      <p className="flex items-center justify-center gap-1.5 text-center text-[13.5px] text-neutral-700">
        <ShieldCheck size={15} /> Trusted browser of <b className="text-black">{name}</b>
      </p>
      <Field label="Your admin password">
        <TextInput type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Err message={error} />
      <Button type="submit" variant="solid" className="w-full" busy={busy} icon={<KeyRound size={15} />}>
        Unlock the admin
      </Button>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => onFull(false)}>
          Use the full sign-in
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onFull(true)}>
          Stop trusting this browser
        </Button>
      </div>
      <p className="text-center text-[11.5px] leading-snug text-neutral-500">Five wrong passwords in a row and this browser is no longer trusted.</p>
    </form>
  )
}

function CodeStep({ challenge, onResend, resending, onBack }: { challenge: AdminWebLoginChallenge; onResend: () => void; resending: boolean; onBack: () => void }) {
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(1000)
  const left = Math.max(0, challenge.expiresAt - now)
  const expired = left === 0
  const tried = useRef<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // A new code (resend) starts clean
  useEffect(() => {
    setCode('')
    setError(null)
    tried.current = null
    input.current?.focus()
  }, [challenge.challengeId])

  const verify = async (value: string) => {
    if (!/^\d{6}$/.test(value)) {
      setError('Enter the 6-digit code from the bot.')
      return
    }
    tried.current = value
    setBusy(true)
    setError(null)
    try {
      // Success unlocks the session; AdminScreen then renders the admin
      await webLoginVerify(challenge.challengeId, value, trust)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  // Pasted or typed: keep the digits only, and check as soon as there are six
  const change = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (digits.length === 6 && digits !== tried.current && !busy) void verify(digits)
  }

  const mm = Math.floor(left / 60_000)
  const ss = Math.floor((left % 60_000) / 1000)

  return (
    <form
      className="mt-5 grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void verify(code)
      }}
    >
      <p className="text-center text-[13.5px] leading-relaxed text-neutral-700">
        We sent a 6-digit code to <b className="text-black">{challenge.sentTo}</b> in Telegram. Open the bot chat and enter it here.
      </p>
      <Check checked={trust} onChange={setTrust}>
        Trust this browser: next time only my password is asked
      </Check>
      <Field label="Code from the bot" aside={expired ? 'expired' : `valid ${mm}:${String(ss).padStart(2, '0')}`}>
        <TextInput
          ref={input}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={12}
          placeholder="123456"
          className="h-12 text-center font-mono text-[22px] font-bold tracking-[0.4em]"
          value={code}
          disabled={expired}
          onChange={(e) => change(e.target.value)}
        />
      </Field>
      <Err message={error} />
      {expired && <Notice>This code has expired. Ask for a new one.</Notice>}
      <Button type="submit" variant="solid" className="w-full" busy={busy} disabled={expired || code.length !== 6} icon={<KeyRound size={15} />}>
        Unlock the admin
      </Button>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Use different details
        </Button>
        <Button variant="ghost" size="sm" busy={resending} onClick={onResend}>
          Send a new code
        </Button>
      </div>
      <p className="text-center text-[11.5px] leading-snug text-neutral-500">No code? Open the bot and press Start, then send a new code. Five wrong tries end this code.</p>
    </form>
  )
}
