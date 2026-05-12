import { Request, Response } from 'express';
import Crowi from 'src/crowi';
import auth from 'src/util/auth';
import Debug from 'debug';
import { AuthenticationRequiredErrorSchema, UserStatusErrorSchema, ThirdPartyAuthRequiredErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';

type AuthenticationRequiredError = z.infer<typeof AuthenticationRequiredErrorSchema>;
type UserStatusError = z.infer<typeof UserStatusErrorSchema>;
type ThirdPartyAuthRequiredError = z.infer<typeof ThirdPartyAuthRequiredErrorSchema>;

export default (crowi: Crowi) => {
  const debug = Debug('crowi:middlewares:loginRequired');

  return async (req: Request, res: Response, next) => {
    const User = crowi.model('User');
    const config = crowi.getConfig();
    const { originalUrl } = req;
    const query = originalUrl === '/' ? '' : `?continue=${originalUrl}`;
    const isAuthPage = originalUrl.startsWith('/me/auth/');
    const isAPI = originalUrl.startsWith('/_api/');

    if (!isAuthPage && auth.isAccessTokenExpired(req)) {
      const success = await auth.reauth(req, config);
      if (!success) {
        const errorResponse: AuthenticationRequiredError = {
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Authentication is required',
            redirectTo: '/logout',
          },
        };
        return res.status(401).json(errorResponse);
      }
    }

    if (req.user && '_id' in req.user) {
      const { 'auth:requireThirdPartyAuth': requireThirdPartyAuth = '' } = config.crowi;
      const hasValidThirdPartyId = req.user.hasValidThirdPartyId();
      if (!isAuthPage && requireThirdPartyAuth && !hasValidThirdPartyId) {
        const errorResponse: ThirdPartyAuthRequiredError = {
          error: {
            code: 'THIRD_PARTY_AUTH_REQUIRED',
            message: 'Third party authentication is required',
            redirectTo: `/me/auth/third-party${query}`,
          },
        };
        return res.status(403).json(errorResponse);
      }

      if (req.user.status === User.STATUS_ACTIVE) {
        // Active の人だけ先に進める
        return next();
      } else if (req.user.status === User.STATUS_REGISTERED) {
        const errorResponse: UserStatusError = {
          error: {
            code: 'USER_REGISTERED',
            message: 'User registration is not complete',
            redirectTo: '/login/error/registered',
          },
        };
        return res.status(403).json(errorResponse);
      } else if (req.user.status === User.STATUS_SUSPENDED) {
        const errorResponse: UserStatusError = {
          error: {
            code: 'USER_SUSPENDED',
            message: 'User account is suspended',
            redirectTo: '/login/error/suspended',
          },
        };
        return res.status(403).json(errorResponse);
      } else if (req.user.status === User.STATUS_INVITED) {
        const errorResponse: UserStatusError = {
          error: {
            code: 'USER_INVITED',
            message: 'User invitation is pending',
            redirectTo: '/login/invited',
          },
        };
        return res.status(403).json(errorResponse);
      }
    }

    const errorResponse: AuthenticationRequiredError = {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required',
        redirectTo: `/login${query}`,
      },
    };
    return res.status(401).json(errorResponse);
  };
};
