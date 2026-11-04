import type { EmailJobData } from '../queues/jobs.js';

/**
 * Transactional email templates — plain, dependency-free. Every link is
 * either a single-use token URL on this API (verification) or a frontend
 * page carrying the token (password reset). Tokens are one-time and short-
 * lived; email content is otherwise non-sensitive.
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">${title}</h2>${bodyHtml}
<p style="color:#666;font-size:12px;margin-top:32px">If you did not request this, you can safely ignore this email.</p>
</body></html>`;
}

export function renderEmail(data: EmailJobData): RenderedEmail {
  switch (data.type) {
    case 'email_verification': {
      const subject = 'Verify your email address';
      const text = `Hi ${data.username},\n\nConfirm your email address by opening this link (valid for 24 hours):\n${data.link}\n`;
      const html = shell(
        'Verify your email address',
        `<p>Hi ${data.username},</p><p>Confirm your email address by clicking the button below. The link is valid for 24 hours.</p>
<p><a href="${data.link}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Verify email</a></p>
<p style="font-size:12px;color:#666">Or paste this URL into your browser: ${data.link}</p>`,
      );
      return { subject, text, html };
    }
    case 'password_reset': {
      const subject = 'Reset your password';
      const text = `Hi ${data.username},\n\nReset your password by opening this link (valid for 1 hour):\n${data.link}\n\nIf you did not request a reset, your password remains unchanged and all sessions stay active.\n`;
      const html = shell(
        'Reset your password',
        `<p>Hi ${data.username},</p><p>Reset your password using the button below. The link is valid for <strong>1 hour</strong>.</p>
<p><a href="${data.link}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
<p style="font-size:12px;color:#666">Or paste this URL into your browser: ${data.link}</p>`,
      );
      return { subject, text, html };
    }
  }
}
