import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { closeRedis, getRedis } from '../../src/lib/redis.js';

/**
 * Integration smoke tests — require real PostgreSQL + Redis (docker compose
 * up -d) and RUN_INTEGRATION=1. These verify the Phase 0 wiring end-to-end:
 * migrations applied, database reachable, Redis reachable, readiness probe
 * reflecting reality.
 */
const runIntegration = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!runIntegration)('integration: readiness', () => {
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
    await closeRedis();
    await prisma.$disconnect();
  });

  it('runs the baseline query against PostgreSQL', async () => {
    const rows = await prisma.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('pings Redis', async () => {
    expect(await getRedis().ping()).toBe('PONG');
  });

  it('reports ready via /readyz', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(payload.status).toBe('ready');
    expect(payload.checks.database).toBe(true);
    expect(payload.checks.redis).toBe(true);
  });
});
