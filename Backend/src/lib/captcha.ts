import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * CAPTCHA integration point (docs/ARCHITECTURE.md §4 J): Cloudflare Turnstile
 * when configured; provider 'none' short-circuits (dev/test + pre-launch).
 * Failures CLOSE the gate (return false) — captcha is an anti-abuse signal,
 * so an unavailable verifier must not silently allow.
 */
export async function verifyCaptcha(token: string | undefined, ip: string | null): Promise<boolean> {
  if (env.CAPTCHA_PROVIDER !== 'turnstile') return true;
  if (!token) return false;
  if (!env.CAPTCHA_SECRET_KEY) {
    logger.error('CAPTCHA_SECRET_KEY missing while turnstile provider is active');
    return false;
  }
  try {
    const res = await fetch(env.CAPTCHA_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.CAPTCHA_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'captcha verification failed');
    return false;
  }
}
