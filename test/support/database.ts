import knex, { type Knex } from 'knex';
import { knexConfig } from '../../src/database';

/** Connects to TEST_DATABASE_URL and resets it to an empty public schema. */
export async function freshDatabase(): Promise<Knex> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required for *.db-spec.ts (a disposable database: it gets wiped)',
    );
  }
  const db = knex(knexConfig(url));
  await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  return db;
}

/** The SQLSTATE and constraint name of a failed query, for asserting which rule fired. */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error('expected the query to fail');
}
