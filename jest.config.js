/**
 * Unit-test config (no DB, no Docker) — runs with `npm test`.
 * Fast domain + application + mapper tests. The merge gate (RUN-TIER-1 step 0)
 * runs this. DB-backed tests live in test/jest-e2e.json (`npm run test:e2e`).
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test/unit'],
  testRegex: '\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {},
};
