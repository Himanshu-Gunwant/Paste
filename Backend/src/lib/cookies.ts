/**
 * Minimal RFC 6265 cookie parsing (avoids a dependency; express `res.cookie`
 * handles serialization). Session cookies are always set via res.cookie with
 * httpOnly + SameSite=Lax + __Host- prefix (Secure in production).
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function getCookie(
  header: string | undefined | null,
  name: string,
): string | undefined {
  return parseCookieHeader(header)[name];
}
