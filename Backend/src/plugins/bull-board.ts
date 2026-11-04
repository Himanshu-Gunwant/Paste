import type { Router } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { QUEUE_NAMES, getQueue } from '../queues/queues.js';

/**
 * Bull Board — dead-letter / backlog view (docs/ARCHITECTURE.md §12.3).
 * Mounted at /admin/queues. PRODUCTION ACCESS CONTROL: Nginx IP-allowlists
 * this path (deploy/nginx.conf) — the app keeps the mount free of session
 * logic so the board works even when auth is degraded.
 */
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

let boardRouter: Router | null = null;

export function createBullBoardRouter(): Router {
  if (!boardRouter) {
    createBullBoard({
      queues: QUEUE_NAMES.map((name) => new BullMQAdapter(getQueue(name))),
      serverAdapter,
    });
    boardRouter = serverAdapter.getRouter();
  }
  return boardRouter as Router;
}
