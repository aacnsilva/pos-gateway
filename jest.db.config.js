/**
 * Tests against a real PostgreSQL. Requires TEST_DATABASE_URL pointing at a disposable
 * database: the suite drops and recreates the public schema. (#14 swaps this for Testcontainers.)
 */
const base = require('./jest.config');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['**/*.db-spec.ts'],
  maxWorkers: 1, // suites share one database
};
