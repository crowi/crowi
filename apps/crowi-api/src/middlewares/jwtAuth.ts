import { Request, Response, NextFunction } from 'express';
import Crowi from 'src/crowi';
import Debug from 'debug';
import { createJwtUtil } from '../util/jwt';
import { AuthenticationRequiredErrorSchema, UserStatusErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';

type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;
type UserStatusError = z.infer<typeof UserStatusErrorSchema>;

export default (crowi: Crowi) => {
  const debug = Debug('crowi:middlewares:jwtAuth');
  const User = crowi.model('User');
  const jwtUtil = createJwtUtil(crowi);

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = jwtUtil.extractTokenFromHeader(authHeader);

    if (!token) {
      const errorResponse: AuthenticationRequiredError = {
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      };
      return res.status(401).json(errorResponse);
    }

    const payload = jwtUtil.verifyToken(token, 'access');
    if (!payload) {
      const errorResponse: AuthenticationRequiredError = {
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      };
      return res.status(401).json(errorResponse);
    }

    try {
      const user = await User.findById(payload.userId);
      
      if (!user) {
        const errorResponse = {
          error: {
            code: 'AUTHENTICATION_REQUIRED' as const,
            message: 'Authentication is required',
          },
        };
        return res.status(401).json(errorResponse);
      }

      if (user.status !== User.STATUS_ACTIVE) {
        let code = 'USER_NOT_ACTIVE';
        let message = 'User account is not active';
        
        if (user.status === User.STATUS_REGISTERED) {
          code = 'USER_REGISTERED';
          message = 'User registration is not complete';
        } else if (user.status === User.STATUS_SUSPENDED) {
          code = 'USER_SUSPENDED';
          message = 'User account is suspended';
        } else if (user.status === User.STATUS_INVITED) {
          code = 'USER_INVITED';
          message = 'User invitation is pending';
        }

        const errorResponse: UserStatusError = {
          error: { 
            code: code as 'USER_REGISTERED' | 'USER_SUSPENDED' | 'USER_INVITED', 
            message,
            redirectTo: user.status === User.STATUS_REGISTERED ? '/login/error/registered' :
                       user.status === User.STATUS_SUSPENDED ? '/login/error/suspended' :
                       '/login/invited'
          },
        };
        return res.status(403).json(errorResponse);
      }

      // Attach user to request
      req.user = user;
      next();
    } catch (error) {
      debug('JWT authentication error:', error);
      const errorResponse: AuthenticationRequiredError = {
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      };
      return res.status(401).json(errorResponse);
    }
  };
};