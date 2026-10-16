import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import knex, { type Knex } from 'knex';
import { knexConfig } from './knex-config';

export const KNEX = Symbol('KNEX');

/**
 * Shared connection pool. Knex connects lazily, so the app (and its tests) can start
 * without a database; readiness (#17) is what reports whether PostgreSQL is reachable.
 */
@Global()
@Module({
  providers: [{ provide: KNEX, useFactory: () => knex(knexConfig()) }],
  exports: [KNEX],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  /** Runs on SIGTERM thanks to enableShutdownHooks(): drain the pool instead of dropping connections. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
