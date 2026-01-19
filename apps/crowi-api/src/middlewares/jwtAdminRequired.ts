import { Request, Response, NextFunction } from 'express';
import Crowi from 'src/crowi';
import jwtAuth from './jwtAuth';

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
      const user = (req as any).user;
      if (!user?.admin) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Admin permission required',
          },
        });
      }

      next();
    });
  };
};
