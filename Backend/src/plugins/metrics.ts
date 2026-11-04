import type { Express, Request, RequestHandler, Response } from 'express';
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from 'prom-client';
import { QUEUE_NAMES, getQueue } from '../queues/queues.js';

/**
 * Prometheus metrics (docs/ARCHITECTURE.md §16): HTTP latency histogram,
 * queue depth/failed gauges, process defaults. Served at /metrics —
 * Nginx DENYs this route publicly; scraping is infrastructure-only.
 */
const httpDuration = new Histogram({
  name: 'paste_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10],
});

const requestsTotal = new Counter({
  name: 'paste_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

const queueDepth = new Gauge({
  name: 'paste_queue_depth',
  help: 'Waiting + delayed jobs per queue',
  labelNames: ['queue'] as const,
});

const queueFailed = new Gauge({
  name: 'paste_queue_failed',
  help: 'Failed (dead-letter) jobs per queue',
  labelNames: ['queue'] as const,
});

collectDefaultMetrics({ prefix: 'paste_process_' });

/** Timing middleware — must run BEFORE the router (mounted first in app.ts). */
export function metricsTiming(): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (req.path === '/metrics') {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      // Route template if available (params resolved), else the raw path.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
      const labels = { method: req.method, route: route.slice(0, 80), status_code: String(res.statusCode) };
      httpDuration.observe(labels, seconds);
      requestsTotal.inc(labels);
    });
    next();
  };
}

async function collectQueueGauges(): Promise<void> {
  await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      try {
        const queue = getQueue(name);
        const counts = await queue.getJobCounts('waiting', 'delayed', 'failed');
        queueDepth.set({ queue: name }, (counts.waiting ?? 0) + (counts.delayed ?? 0));
        queueFailed.set({ queue: name }, counts.failed ?? 0);
      } catch {
        // Redis unavailable — gauges hold last values
      }
    }),
  );
}

export function mountMetrics(app: Express): void {
  app.get('/metrics', async (_req, res) => {
    await collectQueueGauges();
    res.status(200).type(register.contentType);
    res.send(await register.metrics());
  });
}
