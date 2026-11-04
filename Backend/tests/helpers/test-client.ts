import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { getRedis } from '../../src/lib/redis.js';

/**
 * Shared integration-test scaffolding: cookie-aware HTTP client over a real
 * Express instance, MailHog email polling, and Redis rate-limit resets.
 */
export class TestClient {
  private cookies: Record<string, string> = {};
  readonly rawCookies: string[] = [];

  constructor(readonly baseUrl: string) {}

  static async start(): Promise<{ client: TestClient; server: Server; close: () => Promise<void> }> {
    const app = createApp();
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new TestClient(`http://127.0.0.1:${address.port}`);
    return {
      client,
      server,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private captureCookies(res: Response): void {
    const setCookies = res.headers.getSetCookie();
    for (const header of setCookies) {
      const [pair, ...attrs] = header.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => a.trim().toLowerCase().startsWith('expires=thu, 01 jan 1970'));
      if (expired || value === '') delete this.cookies[name];
      else this.cookies[name] = value;
      this.rawCookies.push(header);
    }
  }

  request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; sendCookies?: boolean } = {},
  ): Promise<Response> {
    const { body, headers = {}, sendCookies = true } = options;
    const allHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) allHeaders['content-type'] = 'application/json';
    if (sendCookies && this.cookieHeader()) allHeaders.cookie = this.cookieHeader();
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: allHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    }).then((res) => {
      this.captureCookies(res);
      return res;
    });
  }

  // Test helper: response payloads are dynamic; callers may narrow via the
  // generic when they want types (default `any` keeps assertions readable).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async json<T = any>(
    method: string,
    path: string,
    options?: Parameters<TestClient['request']>[2],
  ): Promise<{ status: number; body: T; res: Response }> {
    const res = await this.request(method, path, options);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, res };
  }

  /** Simulate a fresh browser (clears stored cookies but keeps raw history). */
  clearCookies(): void {
    this.cookies = {};
  }

  setCookie(name: string, value: string): void {
    this.cookies[name] = value;
  }
}

export function uniqueSuffix(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Deletes rate-limit, quota and view-buffer keys so tests start clean. */
export async function resetRateLimits(): Promise<void> {
  const redis = getRedis();
  const patterns = ['rl:*', 'quota:anon:*', 'views:delta:*', 'views:inflight:*'];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

// ---- MailHog helpers ------------------------------------------------------

interface MailHogItem {
  Content: {
    Headers: Record<string, string[]>;
    Body: unknown; // raw string body (MIME-encoded)
  };
  MIME?: {
    Parts?: {
      Headers: Record<string, string[]>;
      Body: unknown; // raw encoded string per part
    }[];
  };
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Extracts decoded text (plain + html parts) from a MailHog v2 message. */
function messageText(item: MailHogItem): string {
  let text = '';
  for (const part of item.MIME?.Parts ?? []) {
    const contentType = part.Headers?.['Content-Type']?.[0] ?? '';
    if (!contentType.startsWith('text/')) continue;
    let body = typeof part.Body === 'string' ? part.Body : String(part.Body ?? '');
    const encoding = part.Headers?.['Content-Transfer-Encoding']?.[0] ?? '';
    if (encoding === 'quoted-printable') body = decodeQuotedPrintable(body);
    else if (encoding === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    text += body;
  }
  if (!text && typeof item.Content.Body === 'string') text = item.Content.Body;
  return text;
}

export async function wipeMailbox(): Promise<void> {
  await fetch('http://127.0.0.1:8025/api/v1/messages', { method: 'DELETE' });
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for an email to arrive (email worker → SMTP → MailHog) and returns its decoded text. */
export async function waitForEmail(to: string, subject: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch('http://127.0.0.1:8025/api/v2/messages');
    if (res.ok) {
      const data = (await res.json()) as { items: MailHogItem[] };
      const item = data.items.find(
        (candidate) =>
          candidate.Content.Headers['To']?.some((header) => header.toLowerCase().includes(to.toLowerCase())) &&
          candidate.Content.Headers['Subject']?.[0] === subject,
      );
      if (item) return messageText(item);
    }
    await sleep(200);
  }
  throw new Error(`no email to ${to} with subject "${subject}" within ${timeoutMs}ms`);
}

export function extractTokenFromLink(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error('no token found in email body');
  return match[1]!;
}
