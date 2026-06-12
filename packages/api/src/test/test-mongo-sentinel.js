const os = require('node:os');
const path = require('node:path');

// File written ONCE by `global-setup.js` (jest main process, before any
// worker forks) and read by every worker's `crowi-environment.js`. It carries
// the resolved external Mongo URI (the docker server) or is empty when none
// was reachable. A file — not `process.env` — because jest does not reliably
// propagate a globalSetup env mutation to every forked worker, but a file
// fully written before the workers start is visible to all of them.
//
// Path is keyed only by the OS tmpdir, so two concurrent full-suite runs on
// one machine share it — which is fine: docker reachability is machine-global,
// so they'd write identical content, and the write is atomic (tmp + rename).
const SENTINEL_PATH = path.join(os.tmpdir(), 'crowi-api-test-mongo-uri');

module.exports = { SENTINEL_PATH };
