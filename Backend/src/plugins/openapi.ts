import type { Express } from 'express';
import { z } from 'zod';
import swaggerUi from 'swagger-ui-express';
import type { ApiKey } from '../generated/prisma/client.js';

/**
 * OpenAPI 3.1 document (docs/ARCHITECTURE.md §4 H, §7). Route metadata is
 * declared here and kept in lock-step with src/routes; request bodies use
 * documentation schemas (plain Zod → JSON Schema via zod v4 native
 * toJSONSchema — the runtime validators keep their normalization transforms).
 */
const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30),
  password: z.string().min(10).max(128),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string() });
const createPasteSchema = z.object({
  content: z.string().max(1_100_000),
  title: z.string().max(140).optional(),
  description: z.string().max(500).optional(),
  language: z.string().optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).default('public'),
  password: z.string().min(4).max(128).optional(),
  expiresIn: z.enum(['10min', '1h', '1d', '1w', '1m']).optional(),
  expiresAt: z.string().datetime().optional(),
  maxViews: z.number().int().min(1).optional(),
  burnAfterRead: z.boolean().default(false),
  customSlug: z.string().min(3).max(64).optional(),
});
const updatePasteSchema = createPasteSchema.partial().extend({
  password: z.string().min(4).max(128).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
const unlockSchema = z.object({ password: z.string() });
const createApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  expiresAt: z.string().datetime().optional(),
});

const jsonBody = (ref: string) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const ok = (description = 'Success') => ({ description });

interface PathDoc {
  summary: string;
  tags: [string];
  security?: 'bearer' | 'cookie' | 'none';
  body?: string;
  params?: string[];
}

const paths: Record<string, Record<string, PathDoc>> = {
  '/auth/register': { post: { summary: 'Create an account and start a session', tags: ['auth'], security: 'none', body: 'RegisterInput' } },
  '/auth/login': { post: { summary: 'Password login (timing-equalized)', tags: ['auth'], security: 'none', body: 'LoginInput' } },
  '/auth/logout': { post: { summary: 'Revoke the current session', tags: ['auth'], security: 'cookie' } },
  '/auth/verify-email/request': { post: { summary: 'Re-send the verification email', tags: ['auth'], security: 'cookie' } },
  '/auth/verify-email/confirm': { post: { summary: 'Consume a verification token', tags: ['auth'], security: 'none' } },
  '/auth/verify-email': { get: { summary: 'Email-link confirmation (redirects)', tags: ['auth'], security: 'none' } },
  '/auth/password-reset/request': { post: { summary: 'Request a reset (always 202)', tags: ['auth'], security: 'none' } },
  '/auth/password-reset/confirm': { post: { summary: 'Set a new password (revokes all sessions)', tags: ['auth'], security: 'none' } },
  '/auth/oauth/{provider}': { get: { summary: 'Start OAuth (state + PKCE)', tags: ['auth'], security: 'none' } },
  '/auth/oauth/{provider}/callback': { get: { summary: 'OAuth callback (linking rules)', tags: ['auth'], security: 'none' } },
  '/users/me': {
    get: { summary: 'Current user', tags: ['users'], security: 'cookie' },
    patch: { summary: 'Update own profile', tags: ['users'], security: 'cookie' },
    delete: { summary: 'Delete own account (PII scrub)', tags: ['users'], security: 'cookie' },
  },
  '/users/me/sessions': {
    get: { summary: 'List active sessions', tags: ['users'], security: 'cookie' },
    delete: { summary: 'Revoke all sessions', tags: ['users'], security: 'cookie' },
  },
  '/users/me/sessions/{id}': { delete: { summary: 'Revoke one session', tags: ['users'], security: 'cookie' } },
  '/users/me/api-usage': { get: { summary: 'Own API usage summary', tags: ['users'], security: 'bearer' } },
  '/users/{username}': { get: { summary: 'Public profile', tags: ['users'], security: 'none' } },
  '/users/{username}/pastes': { get: { summary: 'Public pastes of a user', tags: ['users'], security: 'none' } },
  '/pastes': {
    post: { summary: 'Create paste (Idempotency-Key supported)', tags: ['pastes'], security: 'none', body: 'CreatePasteInput' },
    get: { summary: 'Public feed: latest | popular | trending', tags: ['discovery'], security: 'none' },
  },
  '/pastes/{id}': {
    get: { summary: 'View paste (policy-gated)', tags: ['pastes'], security: 'none' },
    patch: { summary: 'Update (owner / management token / admin)', tags: ['pastes'], security: 'none', body: 'UpdatePasteInput' },
    delete: { summary: 'Soft delete (tombstone + purge)', tags: ['pastes'], security: 'none' },
  },
  '/pastes/{id}/raw': { get: { summary: 'Raw text retrieval', tags: ['pastes'], security: 'none' } },
  '/pastes/{id}/download': { get: { summary: 'Attachment download', tags: ['pastes'], security: 'none' } },
  '/pastes/{id}/unlock': { post: { summary: 'Password gate → full paste', tags: ['pastes'], security: 'none', body: 'UnlockInput' } },
  '/pastes/{id}/fork': { post: { summary: 'Fork (fresh identity)', tags: ['pastes'], security: 'none' } },
  '/pastes/{id}/revisions': { get: { summary: 'Revision history (metadata)', tags: ['revisions'], security: 'none' } },
  '/pastes/{id}/revisions/{no}': { get: { summary: 'Revision snapshot', tags: ['revisions'], security: 'none' } },
  '/pastes/{id}/revisions/{no}/diff': { get: { summary: 'Unified diff between revisions', tags: ['revisions'], security: 'none' } },
  '/pastes/{id}/revisions/{no}/restore': { post: { summary: 'Restore as a NEW revision', tags: ['revisions'], security: 'none' } },
  '/search': { get: { summary: 'Full-text search (public only)', tags: ['discovery'], security: 'none' } },
  '/languages': { get: { summary: 'Language facet counts', tags: ['discovery'], security: 'none' } },
  '/api-keys': {
    post: { summary: 'Create API key (shown once)', tags: ['api-keys'], security: 'cookie', body: 'CreateApiKeyInput' },
    get: { summary: 'List own keys (prefix only)', tags: ['api-keys'], security: 'cookie' },
  },
  '/api-keys/{id}': { delete: { summary: 'Revoke an API key', tags: ['api-keys'], security: 'cookie' } },
  '/reports': { post: { summary: 'Report a paste (anonymous allowed)', tags: ['abuse'], security: 'none' } },
  '/healthz': { get: { summary: 'Liveness', tags: ['meta'], security: 'none' } },
  '/readyz': { get: { summary: 'Readiness (DB + Redis)', tags: ['meta'], security: 'none' } },
};

function buildDocument(): Record<string, unknown> {
  const pathObjects: Record<string, Record<string, unknown>> = {};
  for (const [path, operations] of Object.entries(paths)) {
    pathObjects[path] = {};
    for (const [method, doc] of Object.entries(operations)) {
      const operation: Record<string, unknown> = {
        summary: doc.summary,
        tags: doc.tags,
        responses: { 200: ok(), 201: ok('Created'), 204: ok('No content') },
      };
      if (doc.security && doc.security !== 'none') {
        operation.security = [{ [doc.security === 'bearer' ? 'bearerAuth' : 'cookieAuth']: [] }];
      }
      if (doc.body) {
        operation.requestBody = jsonBody(doc.body);
      }
      pathObjects[path][method] = operation;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Paste Platform API',
      version: '1.0.0',
      description:
        'Pastebin platform backend — session cookie auth for the web app, Bearer API keys for programmatic access. Errors use { error: { code, message, details? }, requestId }.',
    },
    servers: [{ url: '/api/v1' }],
    tags: ['auth', 'users', 'pastes', 'revisions', 'discovery', 'api-keys', 'abuse', 'meta'].map((name) => ({ name })),
    paths: pathObjects,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-sess' },
      },
      schemas: {
        RegisterInput: z.toJSONSchema(registerSchema),
        LoginInput: z.toJSONSchema(loginSchema),
        CreatePasteInput: z.toJSONSchema(createPasteSchema, { io: 'input' }),
        UpdatePasteInput: z.toJSONSchema(updatePasteSchema, { io: 'input' }),
        UnlockInput: z.toJSONSchema(unlockSchema),
        CreateApiKeyInput: z.toJSONSchema(createApiKeySchema),
      },
    },
  };
}

let document: Record<string, unknown> | null = null;

export function mountOpenApi(app: Express): void {
  document ??= buildDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.status(200).json(document);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(document));
}

/** Test/ops helper — the raw key format check used by tooling. */
export function looksLikeApiKey(value: string): boolean {
  return /^pb_[A-Za-z0-9_-]{43}$/.test(value);
}

export type ApiKeyLike = ApiKey;
