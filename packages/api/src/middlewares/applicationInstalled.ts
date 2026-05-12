import { Request, Response, NextFunction } from 'express';
import { ApplicationNotInstalledErrorSchema } from '@crowi/api-contract';
import { z } from 'zod';

type ApplicationNotInstalledError = z.infer<typeof ApplicationNotInstalledErrorSchema>;

export default () => {
  return (req: Request, res: Response, next: NextFunction) => {
    const config = req.config;

    if (Object.keys(config.crowi).length === 1) {
      // app:url is set by process
      const errorResponse: ApplicationNotInstalledError = {
        error: {
          code: 'APPLICATION_NOT_INSTALLED',
          message: 'Application is not installed',
          redirectTo: '/installer',
        },
      };
      return res.status(503).json(errorResponse);
    }

    return next();
  };
};
