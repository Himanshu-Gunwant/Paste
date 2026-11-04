import type { ZodIssue } from 'zod';

/**
 * Error catalog and application error type (docs/ARCHITECTURE.md §7.1).
 * Services throw AppError; the error middleware maps anything else to
 * INTERNAL so no stack or internals ever reach a client.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'PASSWORD_REQUIRED',
  'INVALID_PASSWORD',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_IN_FLIGHT',
  'GONE',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_KEY_REUSED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'OAUTH_EMAIL_UNVERIFIED',
  'PROVIDER_NOT_CONFIGURED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
  requestId: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, statusCode: number, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static validation(message = 'Invalid request', details?: ErrorDetail[]): AppError {
    return new AppError('VALIDATION_ERROR', 400, message, details);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHORIZED', 401, message);
  }

  static forbidden(message = 'You do not have access to this resource'): AppError {
    return new AppError('FORBIDDEN', 403, message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError('NOT_FOUND', 404, message);
  }

  static conflict(message = 'Resource already exists'): AppError {
    return new AppError('CONFLICT', 409, message);
  }

  static gone(message = 'This resource is no longer available'): AppError {
    return new AppError('GONE', 410, message);
  }

  static payloadTooLarge(message = 'Content exceeds the maximum allowed size'): AppError {
    return new AppError('PAYLOAD_TOO_LARGE', 413, message);
  }

  static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError('RATE_LIMITED', 429, message);
  }

  static providerNotConfigured(provider: string): AppError {
    return new AppError('PROVIDER_NOT_CONFIGURED', 503, `OAuth provider "${provider}" is not configured`);
  }

  static oauthEmailUnverified(): AppError {
    return new AppError('OAUTH_EMAIL_UNVERIFIED', 400, 'Provider email is not verified; account creation and linking are refused');
  }

  static quotaExceeded(message = 'Quota exceeded'): AppError {
    return new AppError('QUOTA_EXCEEDED', 429, message);
  }
}

/** Flatten a Zod issue list into the stable wire format. */
export function zodIssuesToDetails(issues: readonly ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
