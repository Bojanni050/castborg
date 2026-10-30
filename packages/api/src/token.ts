import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  siteId: string;
  conversationId: string;
  /** unix-seconden */
  exp: number;
}

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Kort geldige sessietoken, gebonden aan precies één gesprek van één site. */
export function issueSessionToken(
  claims: Omit<SessionClaims, "exp">,
  secret: string,
  ttlSeconds = 2 * 60 * 60,
  now = Date.now(),
): string {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): SessionClaims | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.siteId !== "string" || typeof claims.conversationId !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
