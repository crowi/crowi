import { Request, Response } from 'express';
import { encodeSpace } from 'src/util/path';

export default () => {
  return (req: Request, res: Response, next) => {
    const path = decodeURIComponent(req.originalUrl || '');
    const encodedPath = encodeSpace(path);

    if (path !== encodedPath) {
      return res.redirect(encodedPath);
    }

    return next();
  };
};
