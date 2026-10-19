/**
 * The site's only network calls: its own backend, same origin, under /api.
 * Sessions are an httpOnly cookie the page never sees.
 */

export interface Buyer {
  telegramId: number
  username: string | null
  firstName: string | null
  photoUrl: string | null
  phone: string | null
  email: string | null
  detailsComplete: boolean
}

export interface Pack {
  naira: number
  bonusPercent: number
  label: string | null
}

export interface Me {
  buyer: Buyer
  /** null: the game could not be reached just now */
  account: { exists: true; active: boolean; balance: number } | { exists: false; message: string } | null
  sales: { packages: Pack[]; minNaira: number; maxNaira: number } | null
  rate: { nairaPerRaff: number; validUntil: string } | null
}

export interface Purchase {
  reference: string
  naira: number
  raffs: number
  bonusRaffs: number
  createdAt: string
  state: 'awaiting_payment' | 'crediting' | 'credited' | 'needs_review' | 'failed' | 'expired'
  balanceAfter: number | null
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'OFFLINE', 'No connection. Check your internet and try again.')
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'SERVER_ERROR', json?.error?.message ?? 'Something went wrong. Try again in a minute.')
  return json as T
}

export const api = {
  config: () => call<{ loginBot: string; quoteMinutes: number }>('GET', '/config'),
  login: (widget: Record<string, unknown>) => call<{ buyer: Buyer }>('POST', '/auth/telegram', widget),
  logout: () => call<{ ok: true }>('POST', '/auth/logout', {}),
  me: () => call<Me>('GET', '/me'),
  saveDetails: (phone: string, email: string) => call<{ buyer: Buyer }>('PUT', '/me/details', { phone, email }),
  checkout: (choice: { packageIndex: number } | { naira: number }) =>
    call<{ reference: string; authorizationUrl: string; naira: number; raffs: number; bonusRaffs: number; expiresAt: string }>('POST', '/checkout', choice),
  purchases: () => call<Purchase[]>('GET', '/purchases'),
  purchase: (reference: string) => call<Purchase>('GET', `/purchases/${encodeURIComponent(reference)}`),
}

export const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
export const int = (n: number) => n.toLocaleString('en-NG')
