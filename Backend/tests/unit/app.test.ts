import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';

/**
 * Phase 0 app-level checks: request correlation, the error envelope, and the
 * JSON parse guard — all without touching PostgreSQL/Redis (/healthz and the
 * 404/400 paths are dependency-free by design).
 */
describe('app', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports liveness on /healthz with a correlation id', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const payload = (await res.json()) as { status: string };
    expect(payload.status).toBe('ok');
  });

  it('echoes an inbound X-Request-Id', async () => {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: { 'X-Request-Id': 'test-correlation-id-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('test-correlation-id-123');
  });

  it('returns the standard error envelope for unmatched routes', async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(res.status).toBe(404);
    const payload = (await res.json()) as {
      error: { code: string; message: string };
      requestId: string;
    };
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(payload.requestId).toBeTruthy();
  });

  it('maps malformed JSON bodies to 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${baseUrl}/api/v1/nothing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 envelope (not HTML) for non-API paths', async () => {
    const res = await fetch(`${baseUrl}/some/random/path`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
