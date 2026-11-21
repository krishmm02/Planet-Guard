/**
 * Run tokens: the server's own record of when a run started.
 *
 * The game runs in the browser, so a score is ultimately a claim. To make
 * leaderboard cheating require more than editing one number, every run starts
 * by asking the server for an HMAC-signed {day, startedAt, nonce}. On submit,
 * the server measures the run's duration itself and rejects scores that are
 * impossible for that much play time (see src/actions/index.ts). Signed with
 * the RUN_KEY app secret; no database needed.
 */

const enc = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret)
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keyCache.set(secret, k)
  }
  return k
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface RunClaims {
  day: string
  startedAt: number
  nonce: string
}

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new Error('RUN_KEY is not configured (deepspace secrets set RUN_KEY=...)')
  return secret
}

export async function signRun(secret: string | undefined, claims: RunClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(requireSecret(secret)), enc.encode(body)))
  return `${body}.${b64url(sig)}`
}

export async function verifyRun(secret: string | undefined, token: unknown): Promise<RunClaims | null> {
  if (typeof token !== 'string' || token.length > 400) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(requireSecret(secret)), unb64url(sig), enc.encode(body))
    if (!ok) return null
    const claims = JSON.parse(new TextDecoder().decode(unb64url(body))) as RunClaims
    if (typeof claims.day !== 'string' || typeof claims.startedAt !== 'number' || typeof claims.nonce !== 'string') return null
    return claims
  } catch {
    return null
  }
}
