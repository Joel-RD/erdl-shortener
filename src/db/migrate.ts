import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { logger } from '../logger.js';

/**
 * `import.meta.url` apunta a `src/db/` en desarrollo y a `dist/db/` tras el
 * build; en ambos casos `../../migrations/` cae en la raíz del proyecto.
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

export type MigrationOptions = {
  migrationsDir?: string;
};

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Aplica solo las migraciones pendientes, en orden de nombre.
 *
 * Cada archivo se ejecuta junto con su INSERT en `schema_migrations` dentro de
 * una transacción: o queda la migración completa y registrada, o no queda nada.
 * Por eso arrancar dos veces seguidas no repite trabajo.
 *
 * @returns nombres de los archivos aplicados en esta ejecución (vacío si la DB
 *          ya estaba al día).
 */
export async function runMigrations(
  client: Client,
  options: MigrationOptions = {},
): Promise<string[]> {
  await client.execute(CREATE_MIGRATIONS_TABLE);

  const appliedRows = await client.execute('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((row) => String(row.name)));

  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = await listMigrationFiles(migrationsDir);
  const pending = files.filter((file) => !applied.has(file));

  if (pending.length === 0) {
    logger.debug('migrations_up_to_date');
    return [];
  }

  const appliedNow: string[] = [];

  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const transaction = await client.transaction('write');

    try {
      await transaction.executeMultiple(sql);
      await transaction.execute({
        sql: 'INSERT INTO schema_migrations (name) VALUES (?)',
        args: [file],
      });
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // La transacción ya pudo haberse cerrado al fallar la sentencia.
      }

      throw new Error(`La migración ${file} falló y fue revertida`, {
        cause: error,
      });
    } finally {
      transaction.close();
    }

    appliedNow.push(file);
    logger.info({ migration: file }, 'migration_applied');
  }

  return appliedNow;
}
