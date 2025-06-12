import { Router, Express } from 'express';
import Crowi from 'src/crowi';
import multer from 'multer';
const router = Router();

export default (crowi: Crowi, app: Express, form): Router => {
  const { Attachment } = crowi.controllers;
  const { AccessTokenParser, LoginRequired, CsrfVerify: csrf } = crowi.middlewares;

  const uploads = multer({ dest: crowi.tmpDir + 'uploads' });

  router.use('/attachments*', AccessTokenParser, LoginRequired);

  router.get('/attachments.list', Attachment.api.list);
  router.post('/attachments.add', uploads.single('file'), csrf, Attachment.api.add);
  router.post('/attachments.remove', csrf, Attachment.api.remove);

  return router;
};
