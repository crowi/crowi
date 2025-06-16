import { Request, Response, NextFunction } from 'express';
import { ApplicationNotInstalledError } from '@crowi/api-contract';

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
