import { Request, Response } from 'express';
import { AdminRequiredErrorSchema, AuthenticationRequiredErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';

type AdminRequiredError = z.infer<typeof AdminRequiredErrorSchema>;
type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;

/**
 * Express middleware that checks the current request user has admin permission.
 * Returns JSON error responses (401 / 403) with `redirectTo` field for client compatibility.
 *
 * Pair with `LoginRequired` upstream when the legacy app needs full session checks;
 * this middleware only verifies presence of `req.user` and the admin flag.
 */
export default () => {
  return (req: Request, res: Response, next) => {
    if (req.user?.admin) {
      return next();
    }

    if (req.user) {
      const errorResponse: AdminRequiredError = {
        error: {
          code: 'ADMIN_REQUIRED',
          message: 'Admin permission required',
          redirectTo: '/',
        },
      };
      return res.status(403).json(errorResponse);
    }

    const errorResponse: AuthenticationRequiredError = {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required',
        redirectTo: '/login',
      },
    };
    return res.status(401).json(errorResponse);
  };
};
