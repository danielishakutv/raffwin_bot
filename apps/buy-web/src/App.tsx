/**
 * The whole site: log in with Telegram, add a phone and email once, pick
 * Raffs, pay at Paystack, and come back to /paid, which waits until the
 * Raffs are in the game account. Prices and balances come from this site's
 * backend; the page never talks to anything else.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, int, naira, type Me, type Purchase } from './api'
import { readReturnedLogin, TelegramLogin } from './TelegramLogin'

const SITE = import.meta.env.VITE_SITE_NAME || 'InstaPlay'

type Load = { state: 'loading' } | { state: 'out'; botId: number } | { state: 'in'; me: Me } | { state: 'error'; message: string }

export function App() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const paidRef = useMemo(() => (location.pathname === '/paid' ? new URLSearchParams(location.search).get('reference') : null), [])

  const refresh = useCallback(async () => {
    try {
      const { loginBotId } = await api.config()
      try {
        setLoad({ state: 'in', me: await api.me() })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setLoad({ state: 'out', botId: loginBotId })
        else throw error
      }
    } catch (error) {
      setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Something went wrong.' })
    }
  }, [])
  const onAuth = useCallback(
    (user: Record<string, unknown>) => {
      void api.login(user).then(refresh, (error: unknown) => setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Login failed.' }))
    },
    [refresh],
  )
  useEffect(() => {
    // Back from a full-page Telegram login (phones): the signed result is in the address
    const returned = readReturnedLogin()
    if (returned) onAuth(returned)
    else void refresh()
  }, [refresh, onAuth])

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10 pt-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <a href="/" className="text-[20px] font-extrabold tracking-tight text-night">
          {SITE}
        </a>
        {load.state === 'in' && <Account me={load.me} onSignOut={() => void api.logout().then(refresh)} />}
      </header>

      {load.state === 'loading' && <Skeleton />}
      {load.state === 'error' && (
        <Notice tone="error" action={<Button onClick={() => void refresh()}>Try again</Button>}>
          {load.message}
        </Notice>
      )}
      {load.state === 'out' && <SignedOut botId={load.botId} onAuth={onAuth} paying={!!paidRef} />}
      {load.state === 'in' && (paidRef ? <Paid reference={paidRef} onDone={refresh} /> : <Shop me={load.me} refresh={refresh} />)}

      <footer className="mt-auto pt-10 text-center text-[12px] leading-relaxed text-ink/50">
        Payments are processed securely by Paystack. We never see your card details.
        <br />
        Raffs go to the game account linked to your Telegram.
      </footer>
    </div>
  )
}

/* Signed out ------------------------------------------------------------------- */

function SignedOut({ botId, onAuth, paying }: { botId: number; onAuth: (u: Record<string, unknown>) => void; paying: boolean }) {
  return (
    <section className="card overflow-hidden">
      <div className="bg-night px-5 pb-6 pt-7 text-white">
        <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-white/60">Raffs</p>
        <h1 className="mt-2 text-[28px] font-extrabold leading-tight">Top up your Raffs in a minute</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-white/75">Log in with the Telegram account you play with. Your Raffs land in that account as soon as you pay.</p>
      </div>
      <div className="flex flex-col gap-4 p-5">
        {paying && <Notice tone="info">Log in again to see your payment.</Notice>}
        <TelegramLogin botId={botId} onAuth={onAuth} />
        <ol className="grid gap-2 text-[14px] text-ink/70">
          <Step n={1}>Log in with Telegram</Step>
          <Step n={2}>Choose how many Raffs</Step>
          <Step n={3}>Pay with card, transfer or USSD through Paystack</Step>
        </ol>
      </div>
    </section>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[12px] font-bold text-brand">{n}</span>
      {children}
    </li>
  )
}

/* Signed in -------------------------------------------------------------------- */

function Account({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const name = me.buyer.username ? `@${me.buyer.username}` : (me.buyer.firstName ?? 'You')
  return (
    <div className="flex items-center gap-2">
      {me.buyer.photoUrl ? <img src={me.buyer.photoUrl} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" /> : null}
      <span className="max-w-[9rem] truncate text-[13px] font-semibold">{name}</span>
      <button type="button" onClick={onSignOut} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-ink/60 hover:bg-ink/5">
        Log out
      </button>
    </div>
  )
}

function Shop({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  if (!me.account) {
    return (
      <Notice tone="error" action={<Button onClick={() => void refresh()}>Try again</Button>}>
        We cannot reach your game account right now. Try again in a minute.
      </Notice>
    )
  }
  if (!me.account.exists) return <Notice tone="info">{me.account.message}</Notice>
  if (!me.account.active) return <Notice tone="error">Your game account is suspended, so it cannot receive Raffs. Contact support inside the game.</Notice>

  return (
    <div className="flex flex-col gap-4">
      <section className="card flex items-center justify-between p-5">
        <div>
          <p className="text-[13px] font-semibold text-ink/60">Your Raffs</p>
          <p className="nums mt-1 text-[34px] font-extrabold leading-none">{int(me.account.balance)}</p>
        </div>
        <RaffsBadge />
      </section>
      {me.buyer.detailsComplete ? <Buy me={me} /> : <Details onSaved={refresh} />}
      <History />
    </div>
  )
}

function RaffsBadge() {
  return (
    <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-sun/15 text-[22px] font-black text-sun">
      R
    </span>
  )
}

function Details({ onSaved }: { onSaved: () => Promise<void> }) {
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="card p-5">
      <h2 className="text-[18px] font-bold">Your details</h2>
      <p className="mt-1 text-[13px] text-ink/60">Once only. Paystack sends your receipt to this email, and we call this number if a payment needs checking.</p>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          api
            .saveDetails(phone, email)
            .then(onSaved, (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save.'))
            .finally(() => setBusy(false))
        }}
      >
        <Input label="Phone number" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={setPhone} />
        <Input label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={setEmail} />
        {error && <p className="text-[13px] font-semibold text-red-700">{error}</p>}
        <Button type="submit" disabled={busy || !phone || !email} solid>
          {busy ? 'Saving' : 'Save and continue'}
        </Button>
      </form>
    </section>
  )
}

function Buy({ me }: { me: Me }) {
  const sales = me.sales!
  const rate = me.rate!
  const [choice, setChoice] = useState<number | 'custom'>(sales.packages.length ? Math.min(1, sales.packages.length - 1) : 'custom')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rateKobo = Math.round(rate.nairaPerRaff * 100)
  const pack = choice === 'custom' ? null : sales.packages[choice]
  const amount = pack ? pack.naira : Number(custom.replace(/\D/g, '')) || 0
  const valid = amount >= sales.minNaira && amount <= sales.maxNaira
  const base = valid ? Math.floor((amount * 100) / rateKobo) : 0
  const bonus = pack ? Math.floor((base * pack.bonusPercent) / 100) : 0

  const pay = () => {
    setBusy(true)
    setError(null)
    api
      .checkout(pack ? { packageIndex: choice as number } : { naira: amount })
      .then(
        (r) => window.location.assign(r.authorizationUrl),
        (err: unknown) => {
          setError(err instanceof Error ? err.message : 'The payment could not start.')
          setBusy(false)
        },
      )
  }

  return (
    <section className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[18px] font-bold">Buy Raffs</h2>
        <p className="nums text-[12px] font-semibold text-ink/60">1 Raff = {naira(rate.nairaPerRaff)} this hour</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {sales.packages.map((p, i) => {
          const b = Math.floor((p.naira * 100) / rateKobo)
          const active = choice === i
          return (
            <button
              key={i}
              type="button"
              aria-pressed={active}
              onClick={() => setChoice(i)}
              className={`relative flex flex-col items-start rounded-2xl border p-4 text-left transition ${active ? 'border-brand bg-brand/5 ring-2 ring-brand/30' : 'border-ink/10 hover:border-ink/25'}`}
            >
              {p.label && <span className="absolute -top-2.5 right-3 rounded-full bg-sun px-2 py-0.5 text-[11px] font-bold text-ink">{p.label}</span>}
              <span className="nums text-[20px] font-extrabold">{naira(p.naira)}</span>
              <span className="nums mt-1 text-[14px] font-semibold">{int(b + Math.floor((b * p.bonusPercent) / 100))} Raffs</span>
              <span className={`mt-0.5 text-[12px] ${p.bonusPercent ? 'font-bold text-mint' : 'text-ink/50'}`}>{p.bonusPercent ? `+${p.bonusPercent}% bonus` : 'Standard'}</span>
            </button>
          )
        })}
        <button
          type="button"
          aria-pressed={choice === 'custom'}
          onClick={() => setChoice('custom')}
          className={`col-span-2 rounded-2xl border p-4 text-left transition ${choice === 'custom' ? 'border-brand bg-brand/5 ring-2 ring-brand/30' : 'border-ink/10 hover:border-ink/25'}`}
        >
          <span className="text-[14px] font-bold">Another amount</span>
          <span className="block text-[12px] text-ink/50">
            {naira(sales.minNaira)} to {naira(sales.maxNaira)}
          </span>
          {choice === 'custom' && (
            <span className="mt-3 flex items-center gap-2 rounded-xl border border-ink/15 bg-white px-3" onClick={(e) => e.stopPropagation()}>
              <span className="font-semibold text-ink/60">₦</span>
              <input
                autoFocus
                inputMode="numeric"
                aria-label="Amount in naira"
                className="nums h-11 w-full bg-transparent text-[16px] font-semibold outline-none"
                placeholder="2,500"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ','))}
              />
            </span>
          )}
        </button>
      </div>

      <div className="mt-5 grid gap-1.5 rounded-2xl bg-ink/[0.03] p-4 text-[14px]">
        <Row label="You pay" value={valid ? naira(amount) : '-'} strong />
        <Row label="Raffs" value={valid ? int(base) : '-'} />
        {bonus > 0 && <Row label="Bonus Raffs" value={`+${int(bonus)}`} accent />}
        <Row label="You receive" value={valid ? `${int(base + bonus)} Raffs` : '-'} strong />
      </div>
      {!valid && choice === 'custom' && custom && <p className="mt-2 text-[13px] font-semibold text-red-700">Choose between {naira(sales.minNaira)} and {naira(sales.maxNaira)}.</p>}
      {error && <p className="mt-3 text-[13px] font-semibold text-red-700">{error}</p>}
      <Button className="mt-4 w-full" solid disabled={!valid || base < 1 || busy} onClick={pay}>
        {busy ? 'Opening Paystack' : valid ? `Pay ${naira(amount)}` : 'Pay'}
      </Button>
      <p className="mt-2 text-center text-[12px] text-ink/50">The price is held for you once you continue. Raffs arrive as soon as Paystack confirms.</p>
    </section>
  )
}

/* After Paystack ------------------------------------------------------------------- */

function Paid({ reference, onDone }: { reference: string; onDone: () => Promise<void> }) {
  const [p, setP] = useState<Purchase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)

  useEffect(() => {
    let stop = false
    let timer: number | undefined
    const tick = (n: number) => {
      api.purchase(reference).then(
        (r) => {
          if (stop) return
          setP(r)
          setTries(n)
          // Keep asking while it may still change: up to about 3 minutes
          if ((r.state === 'awaiting_payment' || r.state === 'crediting') && n < 60) timer = window.setTimeout(() => tick(n + 1), 3_000)
        },
        (err: unknown) => !stop && setError(err instanceof Error ? err.message : 'Could not load this payment.'),
      )
    }
    tick(0)
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [reference])

  const home = () => {
    history.replaceState(null, '', '/')
    void onDone()
  }

  if (error) return <Notice tone="error" action={<Button onClick={home}>Back</Button>}>{error}</Notice>
  if (!p) return <Skeleton />
  const waiting = p.state === 'awaiting_payment' || p.state === 'crediting'
  return (
    <section className="card p-6 text-center">
      {p.state === 'credited' ? (
        <>
          <p className="text-[44px]" aria-hidden>
            🎉
          </p>
          <h1 className="mt-2 text-[24px] font-extrabold">{int(p.raffs)} Raffs added</h1>
          <p className="mt-2 text-[15px] text-ink/70">{p.balanceAfter !== null ? `Your balance is now ${int(p.balanceAfter)} Raffs.` : 'They are in your game account.'} Open the game in Telegram to use them.</p>
        </>
      ) : waiting ? (
        <>
          <Spinner />
          <h1 className="mt-4 text-[22px] font-extrabold">{p.state === 'crediting' ? 'Payment received' : 'Waiting for Paystack'}</h1>
          <p className="mt-2 text-[15px] text-ink/70">
            {p.state === 'crediting'
              ? `Adding ${int(p.raffs)} Raffs to your game account.`
              : tries >= 60
                ? 'Your payment has not been confirmed yet. Bank transfers can take a few minutes. You can close this page: the Raffs arrive by themselves once Paystack confirms.'
                : 'This takes a few seconds. Do not pay again.'}
          </p>
        </>
      ) : p.state === 'needs_review' ? (
        <>
          <h1 className="text-[22px] font-extrabold">We are checking this payment</h1>
          <p className="mt-2 text-[15px] text-ink/70">Something about it needs a person to look. Our team has been told and will contact you on your phone. Keep your reference: {p.reference}</p>
        </>
      ) : (
        <>
          <h1 className="text-[22px] font-extrabold">No payment was made</h1>
          <p className="mt-2 text-[15px] text-ink/70">Nothing was charged for this one. Start again when you are ready.</p>
        </>
      )}
      <Button className="mt-6 w-full" solid={!waiting} onClick={home}>
        {p.state === 'credited' ? 'Buy more' : 'Back'}
      </Button>
    </section>
  )
}

function History() {
  const [list, setList] = useState<Purchase[] | null>(null)
  useEffect(() => {
    api.purchases().then(setList, () => setList([]))
  }, [])
  const shown = (list ?? []).filter((p) => p.state !== 'expired' && p.state !== 'failed').slice(0, 10)
  if (!shown.length) return null
  const label: Record<Purchase['state'], string> = {
    credited: 'Added',
    crediting: 'Adding',
    awaiting_payment: 'Not paid yet',
    needs_review: 'Being checked',
    failed: 'Failed',
    expired: 'Expired',
  }
  return (
    <section className="card p-5">
      <h2 className="text-[16px] font-bold">Recent purchases</h2>
      <ul className="mt-3 divide-y divide-ink/5">
        {shown.map((p) => (
          <li key={p.reference} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
            <div className="min-w-0">
              <p className="nums font-semibold">
                {int(p.raffs)} Raffs for {naira(p.naira)}
              </p>
              <p className="text-[12px] text-ink/50">{new Date(p.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${p.state === 'credited' ? 'bg-mint/10 text-mint' : 'bg-ink/5 text-ink/60'}`}>{label[p.state]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* Bits ---------------------------------------------------------------------------- */

function Row({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink/60">{label}</span>
      <span className={`nums ${strong ? 'font-extrabold' : 'font-semibold'} ${accent ? 'text-mint' : ''}`}>{value}</span>
    </div>
  )
}

function Button({ children, solid, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { solid?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-12 items-center justify-center rounded-xl px-5 text-[15px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${solid ? 'bg-brand text-white hover:bg-brand-dark' : 'border border-ink/15 bg-white hover:bg-ink/5'} ${className}`}
    >
      {children}
    </button>
  )
}

function Input({ label, value, onChange, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[13px] font-semibold text-ink/70">{label}</span>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} className="h-12 rounded-xl border border-ink/15 bg-white px-3 text-[16px] outline-none focus:border-brand" />
    </label>
  )
}

function Notice({ tone, children, action }: { tone: 'info' | 'error'; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`card flex flex-col gap-3 p-5 text-[15px] leading-relaxed ${tone === 'error' ? 'border-red-200 bg-red-50 text-red-900' : ''}`}>
      <p>{children}</p>
      {action}
    </div>
  )
}

function Spinner() {
  return <span aria-label="Loading" className="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-brand/20 border-t-brand" />
}

function Skeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <div className="card h-28 animate-pulse" />
      <div className="card h-64 animate-pulse" />
    </div>
  )
}
