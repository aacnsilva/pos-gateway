import type { Knex } from 'knex';
import * as initialSchema from './0001_initial_schema';

/**
 * Ordered list of migrations. Imported statically instead of read from a folder, so the
 * same list works from TypeScript sources (tests) and compiled JavaScript (production),
 * with no file-extension or path juggling. Append new migrations; never edit applied ones.
 */
export const MIGRATIONS: { name: string; migration: Knex.Migration }[] = [
  { name: '0001_initial_schema', migration: initialSchema },
];

export class StaticMigrationSource implements Knex.MigrationSource<string> {
  getMigrations(): Promise<string[]> {
    return Promise.resolve(MIGRATIONS.map((m) => m.name));
  }

  getMigrationName(name: string): string {
    return name;
  }

  getMigration(name: string): Promise<Knex.Migration> {
    const found = MIGRATIONS.find((m) => m.name === name);
    return found
      ? Promise.resolve(found.migration)
      : Promise.reject(new Error(`Unknown migration ${name}`));
  }
}
