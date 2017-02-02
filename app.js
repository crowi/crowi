/**
 * Crowi::app.js
 *
 * @package Crowi
 * @author  Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

require('dotenv').config();

var crowi = new (require('./lib/crowi'))(__dirname, process.env);

crowi.init()
  .then(function() {
    return crowi.start();
  }).catch(crowi.exitOnError);

