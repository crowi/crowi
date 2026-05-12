#!/usr/bin/env node
/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import dotenv from 'dotenv';
import Crowi from 'src/crowi';
import { join, resolve } from 'path';

// load .env
dotenv.config();

const crowi = new Crowi(resolve(join(__dirname, '..')), process.env);

crowi.init().then(crowi.start).catch(crowi.exitOnError);
