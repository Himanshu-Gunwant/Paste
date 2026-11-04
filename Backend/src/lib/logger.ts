import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Root logger. Request-scoped loggers are derived by pino-http with the
 * requestId; workers derive child loggers with jobId. Secrets are redacted
 * defensively — never log request bodies or auth material.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'paste-backend' },
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'apiKey',
      '*.apiKey',
      'authorization',
      'headers.authorization',
      'headers.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});
