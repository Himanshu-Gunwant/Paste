import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  zodIssuesToDetails,
  type ErrorCode,
  type ErrorDetail,
  type ErrorResponseBody,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';

function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorResponseBody {
  return {
    error: { code, message, ...(details ? { details } : {}) },
    requestId,
  };
}

function isBodyParseError(err: unknown): err is Error & { type: string } {
  return (
    err instanceof Error &&
    'type' in err &&
    typeof (err as { type?: unknown }).type === 'string' &&
    (err as { type: string }).type.startsWith('entity.')
  );
}

/** Fallback for unmatched routes — same envelope as service-level errors. */
export const notFoundHandler: RequestHandler = (req: Request, res: Response) => {
  res.status(404).json(errorEnvelope('NOT_FOUND', 'Resource not found', req.id));
};

/**
 * Central error mapper (docs/ARCHITECTURE.md §7.1):
 * AppError and ZodError map to their catalog entries; malformed/too-large
 * bodies map to 400/413; everything else is a logged 500 INTERNAL with no
 * internals leaked. 5xx log with stack; 4xx log at warn without stack.
 */
export const errorHandler: ErrorRequestHandler = (
  err,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let statusCode = 500;
  let code: ErrorCode = 'INTERNAL';
  let message = 'Internal server error';
  let details: ErrorDetail[] | undefined;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid request';
    details = zodIssuesToDetails(err.issues);
  } else if (isBodyParseError(err)) {
    if (err.type === 'entity.too.large') {
      statusCode = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body too large';
    } else {
      statusCode = 400;
      code = 'VALIDATION_ERROR';
      message = 'Malformed JSON body';
    }
  }

  if (statusCode >= 500) {
    logger.error({ err, requestId: req.id }, 'unhandled error');
  } else {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err), requestId: req.id },
      'request failed',
    );
  }

  res.status(statusCode).json(errorEnvelope(code, message, req.id, details));
};
