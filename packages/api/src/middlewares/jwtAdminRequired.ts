import { Request, Response, NextFunction } from 'express';
import Crowi from 'src/crowi';
import { AdminRequiredErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';
import jwtAuth from './jwtAuth';

type AdminRequiredError = z.infer<typeof AdminRequiredErrorSchema>;

/**
 * JWT authentication middleware with admin permission check
 * Returns JSON error responses (401 or 403) for API endpoints
 */
export default (crowi: Crowi) => {
  const checkJwtAuth = jwtAuth(crowi);

  return (req: Request, res: Response, next: NextFunction) => {
    // First check JWT authentication
    checkJwtAuth(req, res, (err) => {
      if (err) {
        // JWT auth failed - already handled by jwtAuth middleware
        return;
      }

      // Check if user has admin permission
      const user = (req as Request & { user?: { admin?: boolean } }).user;
      if (!user?.admin) {
        const errorResponse: AdminRequiredError = {
          error: {
            code: 'ADMIN_REQUIRED',
            message: 'Admin permission required',
          },
        };
        return res.status(403).json(errorResponse);
      }

      next();
    });
  };
};
