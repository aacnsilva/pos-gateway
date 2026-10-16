import knex from 'knex';
import { knexConfig } from './knex-config';

/** `node dist/database/migrate.js latest|rollback|status` */
async function main(command = process.argv[2] ?? 'latest'): Promise<void> {
  const db = knex(knexConfig());
  try {
    if (command === 'latest') {
      const [batch, applied] = (await db.migrate.latest()) as [number, string[]];
      console.log(
        applied.length ? `Batch ${batch}: applied ${applied.join(', ')}` : 'Already up to date',
      );
    } else if (command === 'rollback') {
      const [batch, reverted] = (await db.migrate.rollback(undefined, true)) as [number, string[]];
      console.log(
        reverted.length
          ? `Rolled back batch ${batch}: ${reverted.join(', ')}`
          : 'Nothing to roll back',
      );
    } else if (command === 'status') {
      const [done, pending] = (await db.migrate.list()) as [{ name: string }[], string[]];
      console.log(`Applied: ${done.map((m) => m.name).join(', ') || 'none'}`);
      console.log(`Pending: ${pending.join(', ') || 'none'}`);
    } else {
      throw new Error(`Unknown command ${command}; use latest, rollback or status`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
