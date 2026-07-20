/*
 * Plan 0472 Phase 4 — permissioned guest capability link (SECURITY-SENSITIVE).
 *
 * A capability is a signed, scoped, revocable bearer token handed to a guest as
 * `/?cap=<token>`. It lets an authorized guest talk/type INTO a session — mediated by
 * the AI — WITHOUT any standing account, role password, or control token. It grants
 * ONLY a guest `participant` identity with an encoded scope; it can NEVER encode a
 * presenter/ai role (the server hard-forces participant) and it never bypasses the
 * control-token / role-password gate that governs the real control roles.
 *
 * Token shape (per 0470 §4): `base64url(payloadJSON) "." base64url(HMAC-SHA256(payloadBytes, SECRET))`.
 * Payload: { v:1, sid, role:'participant', scope:['speak','type'], name?, exp (epoch SECONDS), nonce }.
 *
 * SECURITY invariants enforced HERE (the server enforces role/scope/revocation on top):
 *  - The HMAC is verified over the EXACT decoded payload bytes BEFORE any payload field is
 *    parsed or trusted (no "decode-then-check"; a forged payload is never interpreted).
 *  - The signature comparison is CONSTANT-TIME (crypto.timingSafeEqual), never `===`.
 *  - A missing/empty secret DISABLES verification entirely — there is NO insecure default
 *    key and an empty-string secret is treated as "disabled", never as a valid key.
 *  - Malformed / undecodable input returns a clean {ok:false} — it never throws to the caller.
 *  - The rejection object carries an INTERNAL `reason` for server-side logging ONLY; callers
 *    must NEVER surface it (or any secret/nonce material) to the client.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN_LEN = 4096;   // a capability token is small; anything larger is rejected outright

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');   // lenient; a bad body simply fails the HMAC below
}

/*
 * Mint a token for `payload` with `secret`. Used by the server operator (api.mintCap) and by
 * tests. Requires a non-empty secret — minting without a secret is a programming error.
 */
export function mintCapability(payload, secret) {
  if (!secret) throw new Error('capability secret required to mint');
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = createHmac('sha256', secret).update(json).digest();
  return b64urlEncode(json) + '.' + b64urlEncode(sig);
}

/*
 * Verify a token. Returns { ok:true, payload:{v,sid,nonce,name,scope,exp} } on success, else
 * { ok:false, reason } where `reason` is for server-side logging ONLY (never surfaced).
 *
 * Order is deliberate and non-negotiable:
 *   1. secret present?          (no secret ⇒ disabled ⇒ reject ALL)
 *   2. shape sane?              (string, bounded length, exactly one '.')
 *   3. HMAC valid? (constant-time, over the RAW payload bytes)  ← BEFORE any field is trusted
 *   4. only NOW: parse JSON, check v/exp/nonce, then revocation
 */
export function verifyCapability(token, secret, { now = Date.now(), isRevoked } = {}) {
  if (!secret) return { ok: false, reason: 'disabled' };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  let payloadBytes, sig;
  try {
    payloadBytes = b64urlDecode(token.slice(0, dot));
    sig = b64urlDecode(token.slice(dot + 1));
  } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!payloadBytes.length || !sig.length) return { ok: false, reason: 'malformed' };

  // (3) Verify the signature over the RAW bytes BEFORE trusting/parsing anything. Constant-time.
  const expected = createHmac('sha256', secret).update(payloadBytes).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return { ok: false, reason: 'bad-sig' };

  // (4) Signature is authentic ⇒ the payload bytes are trustworthy. Now parse + validate.
  let payload;
  try { payload = JSON.parse(payloadBytes.toString('utf8')); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (payload.v !== 1) return { ok: false, reason: 'version' };
  if (typeof payload.nonce !== 'string' || !payload.nonce) return { ok: false, reason: 'malformed' };
  if (typeof payload.exp !== 'number' || !isFinite(payload.exp) || payload.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  if (typeof isRevoked === 'function' && isRevoked(payload.nonce)) return { ok: false, reason: 'revoked' };

  const scope = Array.isArray(payload.scope) ? payload.scope.filter((s) => typeof s === 'string') : [];
  const name = (typeof payload.name === 'string' && payload.name) ? payload.name : null;
  // NOTE: payload.role is DELIBERATELY IGNORED here. The server hard-forces participant; a token
  // author cannot promote a guest by writing role:'ai' — the returned payload never carries role.
  return { ok: true, payload: { v: 1, sid: (payload.sid != null ? payload.sid : null), nonce: payload.nonce, name, scope, exp: payload.exp } };
}
