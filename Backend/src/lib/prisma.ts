import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Single Prisma client for the API process and the worker process alike.
 * The constructor does not connect; the first query opens the pool.
 */
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}
