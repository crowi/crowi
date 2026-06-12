const fs = require('node:fs');
const { SENTINEL_PATH } = require('./test-mongo-sentinel');

// Best-effort: remove the Mongo-strategy sentinel written by global-setup.js.
// Non-fatal if it's already gone (a concurrent run may have cleaned it).
module.exports = async function globalTeardown() {
  try {
    fs.rmSync(SENTINEL_PATH, { force: true });
  } catch {
    // ignore
  }
};
