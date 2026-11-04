import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { REQUEST_BODY_LIMIT } from './config/constants.js';
import { requestLogging } from './middleware/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { mountOpenApi } from './plugins/openapi.js';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/index.js';

/**
 * Express application assembly (docs/ARCHITECTURE.md §14).
 * Middleware order matters: trust proxy → security headers → CORS →
 * request logging/correlation → body parsing → routes → 404 → error mapper.
 * Business logic lives in services; controllers only adapt HTTP.
 */
export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      // Site-wide clickjacking protection; the Phase 7 embed route will use a
      // frame-ancestors CSP instead (docs/ARCHITECTURE.md §4 I).
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  if (env.FRONTEND_ORIGIN) {
    app.use(
      cors({
        origin: env.FRONTEND_ORIGIN,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      }),
    );
  }

  app.use(requestLogging());
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

  // OpenAPI document + Swagger UI (public, docs/ARCHITECTURE.md §4 H).
  mountOpenApi(app);

  // Unversioned operational endpoints (Nginx exposes /healthz and /readyz).
  app.use(healthRouter);

  // Versioned API — populated by phase (see src/routes/index.ts).
  app.use('/api/v1', apiRouter);

  // Future: GET /embed/:id server-rendered embed route (Phase 7).

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
