import { describe, expect, it } from 'vitest';
import { renderEmail } from '../../src/services/email-templates.js';

describe('email templates', () => {
  it('renders verification email with the single-use link', () => {
    const email = renderEmail({
      type: 'email_verification',
      to: 'alice@example.com',
      username: 'alice',
      link: 'http://localhost:3000/api/v1/auth/verify-email?token=abc123',
    });
    expect(email.subject).toContain('Verify');
    expect(email.text).toContain('token=abc123');
    expect(email.text).toContain('24 hours');
    expect(email.html).toContain('href="http://localhost:3000/api/v1/auth/verify-email?token=abc123"');
    expect(email.html).toContain('alice');
  });

  it('renders password reset email with the 1-hour validity note', () => {
    const email = renderEmail({
      type: 'password_reset',
      to: 'bob@example.com',
      username: 'bob',
      link: 'http://localhost:5173/reset-password?token=xyz789',
    });
    expect(email.subject).toContain('Reset');
    expect(email.text).toContain('token=xyz789');
    expect(email.text).toContain('1 hour');
    expect(email.html).toContain('token=xyz789');
  });
});
