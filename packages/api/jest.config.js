// For a detailed explanation regarding each configuration property, visit:
// https://jestjs.io/docs/en/configuration.html
//
// ---------------------------------------------------------------------------
// Why `package.json`'s `test` script runs `node --no-sparkplug
// node_modules/jest/bin/jest.js` instead of plain `jest`
// ---------------------------------------------------------------------------
// Node 24.x carries a V8 (13.6) bug: when a stack-guard interrupt triggers a
// Mark-Compact GC during a Sparkplug (baseline JIT) prologue, the
// half-constructed frame is walked as a GC root and a garbage slot value is
// dereferenced — SIGSEGV, `KERN_INVALID_ADDRESS at 0x6`, faulting in
// `ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers` <-
// `InternalFrame::Iterate`. It surfaces here as a jest WORKER dying
// (`A jest worker process was terminated ... signal=SIGSEGV`), which jest
// then attributes to whichever test file that worker happened to be running
// — an innocent bystander, not the trigger. Reproduced three times on this
// codebase (crash reports under ~/Library/Logs/DiagnosticReports).
//
// Upstream: https://github.com/nodejs/node/issues/62393 — fixed in Node
// 25.0.0+, NOT backported to 24.x as of 24.18.0. `--no-sparkplug` removes the
// baseline-JIT stage the race lives in.
//
// The flag cannot go in NODE_OPTIONS (`--no-sparkplug is not allowed in
// NODE_OPTIONS`), and `node_modules/.bin/jest` is a shell shim that swallows
// node flags — hence invoking `jest.js` through node directly. jest-worker
// forwards `process.execArgv` to its children, so all workers inherit it.
//
// REMOVE THIS once the fix reaches our Node floor (a 24.x backport, or
// `engines` moving to >= 25). Verify with the flag dropped before deleting:
// the bug is probabilistic, roughly 0.5 crashes/day under continuous
// parallel use here.
// ---------------------------------------------------------------------------

module.exports = {
  // All imported modules in your tests should be mocked automatically
  // automock: false,

  // Stop running tests after the first failure
  // bail: false,

  // Respect "browser" field in package.json when resolving modules
  // browser: false,

  // The directory where Jest should store its cached dependency information
  // cacheDirectory: "/tmp/jest_0",

  // Automatically clear mock calls and instances between every test
  clearMocks: true,

  // Indicates whether the coverage information should be collected while executing the test
  // collectCoverage: false,

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: ['{common,src}/**/*.{ts,tsx}', '!{common,src}/test', '!{common,src}/**/*.test.{ts,tsx}'],

  // The directory where Jest should output its coverage files
  coverageDirectory: 'coverage',

  // An array of regexp pattern strings used to skip coverage collection
  // coveragePathIgnorePatterns: [
  //   "/node_modules/"
  // ],

  // A list of reporter names that Jest uses when writing coverage reports
  // coverageReporters: [
  //   "json",
  //   "text",
  //   "lcov",
  //   "clover"
  // ],

  // An object that configures minimum threshold enforcement for coverage results
  // coverageThreshold: null,

  // Make calling deprecated APIs throw helpful error messages
  // errorOnDeprecated: false,

  // Force coverage collection from ignored files usin a array of glob patterns
  // forceCoverageMatch: [],

  // A path to a module which exports an async function that is triggered once before all test suites.
  // Detects a reachable local docker Mongo (once, pre-fork) and records it in a
  // sentinel file that crowi-environment.js reads, so all workers use it
  // instead of per-file memory-servers. See the module for the why.
  globalSetup: './src/test/global-setup.js',

  // A path to a module which exports an async function that is triggered once after all test suites.
  // Removes the Mongo-strategy sentinel written by globalSetup.
  globalTeardown: './src/test/global-teardown.js',

  // A set of global variables that need to be available in all test environments
  globals: {},

  // An array of directory names to be searched recursively up from the requiring module's location
  // moduleDirectories: [
  //   "node_modules"
  // ],

  // An array of file extensions your modules use
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'jsx', 'node'],

  // A map from regular expressions to module names that allow to stub out resources with a single module
  moduleNameMapper: {
    '^src/(.*)': '<rootDir>/src/$1',
    '^client/(.*)': '<rootDir>/client/$1',
    '^common/(.*)': '<rootDir>/common/$1',
  },

  // An array of regexp pattern strings, matched against all module paths before considered 'visible' to the module loader
  // modulePathIgnorePatterns: [],

  // Activates notifications for test results
  // notify: false,

  // An enum that specifies notification mode. Requires { notify: true }
  // notifyMode: "always",

  // A preset that is used as a base for Jest's configuration
  // preset: 'ts-jest',

  // Run tests from one or more projects
  projects: [
    {
      displayName: 'common',
      preset: 'ts-jest',
      testMatch: ['<rootDir>/common/**/*.test.ts'],
      moduleNameMapper: {
        '^src/(.*)': '<rootDir>/src/$1',
        '^client/(.*)': '<rootDir>/client/$1',
        '^common/(.*)': '<rootDir>/common/$1',
      },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
          },
        ],
      },
    },
    {
      displayName: 'server',
      preset: 'ts-jest',
      // `clearMocks` (root) only clears calls — a `jest.spyOn` implementation
      // replacement would otherwise leak into the next test. Restore spies
      // automatically so no test depends on a leftover spy.
      restoreMocks: true,
      testEnvironment: './src/test/crowi-environment.js',
      setupFilesAfterEnv: ['./src/test/setup.ts'],
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      // Redis smoke files run in the dedicated `redis-smoke` project below
      // WITHOUT `setup.ts` — 7 of the 8 never touch the `crowi` singleton,
      // and the full per-file Crowi boot + scratch-Mongo create/drop cycle
      // is pure waste for them. `crowi/index.smoke.test.ts` is the one
      // exception (it exercises the real boot path via the singleton), so
      // the lookbehind keeps it here.
      testPathIgnorePatterns: ['(?<!crowi/index)\\.smoke\\.test\\.ts$'],
      moduleNameMapper: {
        '^src/(.*)': '<rootDir>/src/$1',
        '^client/(.*)': '<rootDir>/client/$1',
        '^common/(.*)': '<rootDir>/common/$1',
      },
      transform: {
        // RFC-0006 Phase 6 — `@scalar/hono-api-reference` is published as
        // pure ESM with a `.js` extension. ts-jest will down-compile its
        // `import` statements to `require()` when we add the package path
        // to the `.js` transform pattern, so Jest's CJS runtime can load it.
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
          },
        ],
        '.+@scalar/.+\\.js$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
            useESM: false,
          },
        ],
      },
      transformIgnorePatterns: ['/node_modules/(?!(.*\\.mjs$|.*@scalar/.+))'],
    },
    {
      displayName: 'redis-smoke',
      preset: 'ts-jest',
      restoreMocks: true,
      // Plain node environment, no `setup.ts`: these files talk only to the
      // real Redis targets `global-setup.js` probed (skip-gated via the
      // connectivity sentinel) — no Crowi boot, no Mongo.
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.smoke.test.ts'],
      testPathIgnorePatterns: ['crowi/index\\.smoke\\.test\\.ts$'],
      moduleNameMapper: {
        '^src/(.*)': '<rootDir>/src/$1',
        '^client/(.*)': '<rootDir>/client/$1',
        '^common/(.*)': '<rootDir>/common/$1',
      },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: 'tsconfig.json',
          },
        ],
      },
    },
  ],

  // Use this configuration option to add custom reporters to Jest
  //
  // `reporters` is a GLOBAL-ONLY jest option — `jest-config`'s
  // `ValidConfig.initialProjectOptions` (the schema per-project entries in
  // `projects` above are validated against) does not include it, so setting
  // it inside the `server` project entry produces a silent "Unknown option"
  // validation warning and never actually wires the reporter in. It must
  // live here, at the top level, even though it exists specifically to
  // instrument the `server` project's tests (feature-flake-failure-taxonomy
  // AC-1) — see `failure-taxonomy-reporter.js`'s doc comment for why it must
  // be the parent-process reporter, not a worker-side hook, to reliably
  // catch a worker crash (e.g. SIGSEGV). `'default'` keeps the normal
  // on-screen jest output; this is purely additive. `onTestResult` also
  // sees `common` project results (harmless — a non-pass `common` file just
  // gets recorded into the same taxonomy channel too, which AC-1's "api
  // jest の非 pass file" wording does not exclude).
  reporters: ['default', './src/test/failure-taxonomy-reporter.js'],

  // Automatically reset mock state between every test
  // resetMocks: false,

  // Reset the module registry before running each individual test
  // resetModules: false,

  // A path to a custom resolver
  // resolver: null,

  // Automatically restore mock state between every test
  // restoreMocks: false,

  // The root directory that Jest should scan for tests and modules within
  // rootDir: null,

  // A list of paths to directories that Jest should use to search for files in
  // roots: [
  //   "<rootDir>"
  // ],

  // Allows you to use a custom runner instead of Jest's default test runner
  // runner: "jest-runner",

  // The paths to modules that run some code to configure or set up the testing environment before each test
  setupFiles: ['regenerator-runtime/runtime'],

  // The path to a module that runs some code to configure or set up the testing framework before each test
  // setupTestFrameworkScriptFile: null,

  // A list of paths to snapshot serializer modules Jest should use for snapshot testing
  // snapshotSerializers: [],

  // The test environment that will be used for testing
  // testEnvironment: "jest-environment-jsdom",

  // extensionsToTreatAsEsm: ['.ts'],

  // Options that will be passed to the testEnvironment
  // testEnvironmentOptions: {},

  // Adds a location field to test results
  // testLocationInResults: false,

  // The glob patterns Jest uses to detect test files
  // testMatch: [
  //   "**/__tests__/**/*.js?(x)",
  //   "**/?(*.)+(spec|test).js?(x)"
  // ],

  // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped
  // testPathIgnorePatterns: [
  //   "/node_modules/"
  // ],

  // The regexp pattern Jest uses to detect test files
  // testRegex: "",

  // This option allows the use of a custom results processor
  // testResultsProcessor: null,

  // This option allows use of a custom test runner
  // testRunner: "jasmine2",

  // This option sets the URL for the jsdom environment. It is reflected in properties such as location.href
  // testURL: "http://localhost",

  // Setting this value to "fake" allows the use of fake timers for functions such as "setTimeout"
  // timers: "real",

  // A map from regular expressions to paths to transformers
  // transform: {
  //   '^.+\\.tsx?$': [
  //     'ts-jest',
  //     {
  //       tsconfig: 'tsconfig.json',
  //     },
  //   ],
  // },

  // An array of regexp pattern strings that are matched against all source file paths, matched files will skip transformation
  transformIgnorePatterns: ['/node_modules/(?!(.*\\.mjs$))'],

  // An array of regexp pattern strings that are matched against all modules before the module loader will automatically return a mock for them
  // unmockedModulePathPatterns: undefined,

  // Indicates whether each individual test should be reported during the run
  // verbose: null,

  // An array of regexp patterns that are matched against all source file paths before re-running tests in watch mode
  // watchPathIgnorePatterns: [],

  // Whether to use watchman for file crawling
  // watchman: true,
};
