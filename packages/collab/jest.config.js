/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // Smoke test spins up an in-memory MongoDB and drives the Phase 3
  // hooks directly. Allow generous slack so CI cold-starts don't
  // false-flag.
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
};
