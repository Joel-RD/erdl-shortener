import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import { configureDatabase, createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

export type TempDatabase = {
  client: Client;
  cleanup: () => Promise<void>;
};

/**
 * DB SQLite temporal, ya migrada, para tests de integración aislados.
 * No se compila al bundle de producción (ver tsconfig.build.json).
 */
export async function createTempDatabase(): Promise<TempDatabase> {
  const dir = await mkdtemp(join(tmpdir(), 'erdl-test-'));
  const client = createDatabaseClient({
    url: pathToFileURL(join(dir, 'test.db')).href,
  });

  await configureDatabase(client);
  await runMigrations(client);

  return {
    client,
    cleanup: async () => {
      client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
