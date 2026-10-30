import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Auth voor het dashboard: één operator, één wachtwoord uit de omgeving.
 *
 * Waarom geen users-tabel: er is nog één gebruiker en de actor-kolom in de instellingenhistorie
 * accepteert al een `user`-id zonder schemawijziging. Zodra een klant zelf moet inloggen wordt dit
 * een echte users-tabel met een wachtwoordhash per rij; deze module is daar de naad voor.
 *
 * De sessie is stateless: de cookie bevat alleen `sub` en `exp`, ondertekend met SESSION_SECRET.
 * Gevolg dat je moet weten: uitloggen wist de cookie, maar een gekopieerde cookie blijft geldig tot
 * hij verloopt. Echte intrekking vraagt een sessietabel; dat komt met meerdere gebruikers.
 */

export const DASHBOARD_COOKIE = "ai_lead_dashboard";

export interface DashboardAuthConfig {
  /** Wachtwoord uit de omgeving. Alleen de hash daarvan wordt vergeleken. */
  password: string;
  /** Naam die in de instellingenhistorie als actor komt te staan. */
  actorId: string;
  /** Hoe lang een sessie geldig blijft. Standaard 8 uur. */
  ttlSeconds?: number;
  /** Zet het Secure-attribuut; verplicht zodra het dashboard achter https hangt. */
  cookieSecure?: boolean;
}

export interface DashboardClaims {
  typ: "dashboard";
  sub: string;
  /** unix-seconden */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Vergelijkt twee wachtwoorden in constante tijd, ongeacht hun lengte. */
export function verifyPassword(input: string, expected: string): boolean {
  return timingSafeEqual(digest(input), digest(expected));
}

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueDashboardToken(
  claims: Omit<DashboardClaims, "exp" | "typ">,
  secret: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
): string {
  const payload = b64(JSON.stringify({ typ: "dashboard", ...claims, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyDashboardToken(token: string, secret: string, now = Date.now()): DashboardClaims | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<DashboardClaims>;
    // De widget-token heeft een ander payload-vorm; deze check houdt de twee soorten gescheiden.
    if (claims.typ !== "dashboard") return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
    return { typ: "dashboard", sub: claims.sub, exp: claims.exp };
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export function serializeCookie(token: string, config: DashboardAuthConfig): string {
  const ttl = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const attrs = [`${DASHBOARD_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${ttl}`];
  if (config.cookieSecure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(config: Pick<DashboardAuthConfig, "cookieSecure">): string {
  const attrs = [`${DASHBOARD_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (config.cookieSecure) attrs.push("Secure");
  return attrs.join("; ");
}
