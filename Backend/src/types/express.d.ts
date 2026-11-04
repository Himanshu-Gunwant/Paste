// Module augmentation (must be a module file — an ambient `declare module`
// in a script-context .d.ts would override the resolved @types package).
import type { AuthContext } from './auth.js';
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Correlation id set by pino-http (propagated to queue jobs and the error
     * envelope). Narrowed to string; pino-http's broader ReqId augmentation
     * on http.IncomingMessage remains the base type.
     */
    id: string;
    /** Auth context resolved by middleware/auth-context.ts (never undefined). */
    auth: AuthContext;
  }
}
