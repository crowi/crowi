/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv'
import Crowi from 'server/crowi'
import { join, resolve } from 'path'

import * as Sentry from '@sentry/node'

// load .env
dotenv.config()

if (process.env.SENTRY_DSN) {
  Sentry.init({
    environment: process.env.NODE_ENV,
    dsn: process.env.SENTRY_DSN,
  })
}

const crowi = new Crowi(resolve(join(__dirname, '..')), process.env)

crowi
  .init()
  .then(crowi.start)
  .catch(crowi.exitOnError)
