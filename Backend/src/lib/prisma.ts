import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Single Prisma client for the API process and the worker process alike.
 * Prisma 7 with the PostgreSQL driver adapter (@prisma/adapter-pg): queries
 * run through node-postgres with the query compiler — no native engine
 * binary. The constructor does not connect; the first query opens the pool.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}
