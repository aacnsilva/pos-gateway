import type { Knex } from 'knex';
import { StaticMigrationSource } from './migrations';

export function knexConfig(connectionString = process.env.DATABASE_URL): Knex.Config {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set (e.g. postgres://postgres@localhost:5432/pos_gateway)',
    );
  }
  return {
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
    migrations: { migrationSource: new StaticMigrationSource(), tableName: 'knex_migrations' },
  };
}
