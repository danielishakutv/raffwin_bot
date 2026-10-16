/**
 * Short-lived access tokens (HS256 JWT). They carry the user and session id;
 * the session row is the source of truth for revocation, checked on refresh.
 */
import { errors, jwtVerify, SignJWT } from 'jose'

const ISSUER = 'raffwin-api'
const AUDIENCE = 'raffwin-miniapp'

export interface AccessClaims {
  userId: string
  sessionId: string
}

export class AccessTokens {
  private readonly key: Uint8Array

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret)
  }

  async issue(claims: AccessClaims, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
    const iat = Math.floor(now / 1000)
    const exp = iat + this.ttlSeconds
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key)
    return { token, expiresAt: exp * 1000 }
  }

  /** 'expired' and 'invalid' are separate so the client knows whether to refresh. */
  async verify(token: string): Promise<{ ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      })
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return { ok: false, reason: 'invalid' }
      return { ok: true, claims: { userId: payload.sub, sessionId: payload.sid } }
    } catch (error) {
      if (error instanceof errors.JWTExpired) return { ok: false, reason: 'expired' }
      return { ok: false, reason: 'invalid' }
    }
  }
}
