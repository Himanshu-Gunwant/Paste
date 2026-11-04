import { describe, expect, it } from 'vitest';
import { AppError, zodIssuesToDetails } from '../../src/lib/errors.js';
import { z } from 'zod';

describe('AppError', () => {
  it('carries code, status and message', () => {
    const err = AppError.notFound();
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe('AppError');
    expect(err instanceof Error).toBe(true);
  });

  it('factory helpers map to the catalog', () => {
    expect(AppError.validation().statusCode).toBe(400);
    expect(AppError.unauthorized().statusCode).toBe(401);
    expect(AppError.forbidden().statusCode).toBe(403);
    expect(AppError.conflict().statusCode).toBe(409);
    expect(AppError.gone().statusCode).toBe(410);
    expect(AppError.payloadTooLarge().statusCode).toBe(413);
    expect(AppError.tooManyRequests().statusCode).toBe(429);
  });

  it('carries validation details', () => {
    const err = AppError.validation('Bad paste', [
      { path: 'content', message: 'exceeds 1MB' },
    ]);
    expect(err.details).toEqual([{ path: 'content', message: 'exceeds 1MB' }]);
  });
});

describe('zodIssuesToDetails', () => {
  it('flattens zod issues into the wire format', () => {
    const schema = z.object({ content: z.string().max(3), port: z.coerce.number() });
    const result = schema.safeParse({ content: 'too long', port: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const details = zodIssuesToDetails(result.error.issues);
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((detail) => detail.path.length > 0 && detail.message.length > 0)).toBe(
        true,
      );
    }
  });
});
