/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv'
import Crowi from 'server/crowi'

// load .env
dotenv.config()

const crowi = new Crowi(__dirname, process.env)

crowi
  .init()
  .then(crowi.start)
  .catch(crowi.exitOnError)
