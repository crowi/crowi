/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv'
import Crowi from 'server/crowi'
import { join } from 'path'

// load .env
dotenv.config()

const crowi = new Crowi(join(__dirname, '..'), process.env)

crowi
  .init()
  .then(crowi.start)
  .catch(crowi.exitOnError)
