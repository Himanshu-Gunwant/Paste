import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError, zodIssuesToDetails } from '../lib/errors.js';

/**
 * Zod validation middleware (docs/ARCHITECTURE.md §14): the ONLY place
 * request shapes are parsed; parsed values land on req.validated and are
 * read by controllers via the schema's inferred input types. Failures map
 * to the standard 400 VALIDATION_ERROR envelope with field details.
 */
function parseOrThrow(schema: ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.validation('Invalid request', zodIssuesToDetails(result.error.issues));
  }
  return result.data;
}

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    try {
      req.validated.body = parseOrThrow(schema, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateQuery(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    try {
      req.validated.query = parseOrThrow(schema, req.query);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateParams(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    try {
      req.validated.params = parseOrThrow(schema, req.params);
      next();
    } catch (err) {
      next(err);
    }
  };
}
