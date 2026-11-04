import { Router } from 'express';

/**
 * Versioned API surface. Routes are thin wiring only — controllers validate,
 * services decide (docs/ARCHITECTURE.md §14).
 *
 * Phase roadmap (docs/ARCHITECTURE.md §19):
 *   Phase 1: authRouter, usersRouter
 *   Phase 2: pastesRouter (+ reports skeleton in Phase 8)
 *   ...
 */
export const apiRouter = Router();
