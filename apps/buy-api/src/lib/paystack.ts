/**
 * Paystack: the webhook signature, and the three calls we make.
 *
 *   x-paystack-signature = hex(HMAC_SHA512(key = secret key, raw request body))
 *
 * The signature only says Paystack sent the event. Before anything is
 * credited the transaction is fetched again with GET /transaction/verify
 * (services/payments.ts), and what that says is what counts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export function paystackSignature(rawBody: Buffer | string, secretKey: string): string {
  return createHmac('sha512', secretKey).update(rawBody).digest('hex')
}

export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature || !/^[0-9a-f]{128}$/.test(signature)) return false
  const expected = Buffer.from(paystackSignature(rawBody, secretKey), 'hex')
  const given = Buffer.from(signature, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** The parts of a transaction we read; Paystack sends much more */
export const paystackTransaction = z.object({
  id: z.number(),
  status: z.string(),
  reference: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  paid_at: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  // Metadata comes back as an object, or as a JSON string when it was sent as one
  metadata: z.union([z.record(z.string(), z.unknown()), z.string(), z.null()]).optional(),
})
export type PaystackTransaction = z.infer<typeof paystackTransaction>

export function metadataOf(tx: PaystackTransaction): Record<string, unknown> {
  if (!tx.metadata) return {}
  if (typeof tx.metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(tx.metadata)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return tx.metadata
}

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'PaystackError'
  }
}

export class Paystack {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new PaystackError(`Paystack unreachable: ${(error as Error).name}`, null)
    }
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: unknown; meta?: unknown } | null
    if (!res.ok || !json?.status) throw new PaystackError(`Paystack ${method} ${path.split('?')[0]}: ${res.status} ${json?.message ?? ''}`.trim(), res.status)
    return json as T
  }

  async initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl: string; metadata: Record<string, unknown> }) {
    const r = await this.call<{ data: { authorization_url: string; access_code: string; reference: string } }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountKobo,
      currency: 'NGN',
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    })
    return { authorizationUrl: r.data.authorization_url, reference: r.data.reference }
  }

  async verify(reference: string): Promise<PaystackTransaction> {
    const r = await this.call<{ data: unknown }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
    return paystackTransaction.parse(r.data)
  }

  /** Successful transactions in a window, one page at a time */
  async listSuccessful(from: Date, to: Date, page: number): Promise<{ transactions: PaystackTransaction[]; pageCount: number }> {
    const q = new URLSearchParams({ status: 'success', from: from.toISOString(), to: to.toISOString(), perPage: '100', page: String(page) })
    const r = await this.call<{ data: unknown[]; meta?: { pageCount?: number } }>('GET', `/transaction?${q}`)
    return { transactions: r.data.map((t) => paystackTransaction.parse(t)), pageCount: r.meta?.pageCount ?? 1 }
  }
}
