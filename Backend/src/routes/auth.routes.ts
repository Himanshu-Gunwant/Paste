import { Router } from 'express';
import { RATE_LIMITS } from '../config/constants.js';
import { requireAuth } from '../middleware/require-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as authController from '../controllers/auth.controller.js';
import {
  loginSchema,
  oauthProviderParamsSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  verifyEmailConfirmSchema,
  verifyEmailQuerySchema,
} from '../validators/auth.validators.js';

/**
 * Auth routes (docs/ARCHITECTURE.md §7.2). Every endpoint is rate-limited:
 * register/login/reset carry brute-force budgets per IP and per email.
 */
export const authRouter = Router();

const authLimiter = rateLimit({ bucket: 'auth', ...RATE_LIMITS.AUTH });
const loginEmailLimiter = rateLimit({
  bucket: 'login-email',
  ...RATE_LIMITS.LOGIN_PER_EMAIL,
  identity: (req) => {
    const email = typeof req.body?.['email'] === 'string' ? req.body['email'] : 'none';
    return `${req.ip ?? 'unknown'}:${email.toLowerCase()}`;
  },
});
const passwordResetLimiter = rateLimit({ bucket: 'password-reset', ...RATE_LIMITS.PASSWORD_RESET });
const verifyEmailLimiter = rateLimit({ bucket: 'verify-email', ...RATE_LIMITS.VERIFY_EMAIL });
const oauthLimiter = rateLimit({ bucket: 'oauth', ...RATE_LIMITS.OAUTH });

authRouter.post('/register', authLimiter, validateBody(registerSchema), authController.register);
authRouter.post(
  '/login',
  authLimiter,
  loginEmailLimiter,
  validateBody(loginSchema),
  authController.login,
);
authRouter.post('/logout', authLimiter, authController.logout);

authRouter.post(
  '/verify-email/request',
  requireAuth(),
  verifyEmailLimiter,
  authController.requestEmailVerification,
);
authRouter.post(
  '/verify-email/confirm',
  verifyEmailLimiter,
  validateBody(verifyEmailConfirmSchema),
  authController.confirmPasswordVerification,
);
// Email-link flow: token arrives by URL, single-use, then redirects to the frontend.
authRouter.get('/verify-email', verifyEmailLimiter, validateQuery(verifyEmailQuerySchema), authController.verifyEmailRedirect);

authRouter.post(
  '/password-reset/request',
  passwordResetLimiter,
  validateBody(passwordResetRequestSchema),
  authController.requestPasswordReset,
);
authRouter.post(
  '/password-reset/confirm',
  passwordResetLimiter,
  validateBody(passwordResetConfirmSchema),
  authController.confirmPasswordReset,
);

authRouter.get('/oauth/:provider', oauthLimiter, validateParams(oauthProviderParamsSchema), authController.oauthStart);
authRouter.get('/oauth/:provider/callback', oauthLimiter, validateParams(oauthProviderParamsSchema), authController.oauthCallback);
