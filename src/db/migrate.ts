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

export type BaselineOptions = {
  migrationsDir?: string;
  /** Si es true no escribe nada: solo informa de lo que haría. */
  dryRun?: boolean;
};

export type BaselineResult = {
  dryRun: boolean;
  /** Migraciones que se registraron (o se registrarían) como aplicadas. */
  recorded: string[];
  /**
   * Migraciones que no se pueden dar por aplicadas: su esquema está
   * incompleto o no se pudo reconocer. Requieren revisión manual.
   */
  pending: string[];
};

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

/**
 * Nombres de los objetos (tablas e índices) que crea una migración. Se usa
 * solo para el baseline: comprobar contra `sqlite_master` si el esquema ya
 * existe aunque `schema_migrations` esté vacía.
 */
const CREATE_OBJECT_PATTERN =
  /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;

export function extractCreatedObjects(sql: string): string[] {
  const names = new Set<string>();
  // Ignorar comentarios: pueden mencionar CREATE TABLE sin ejecutarlo.
  const statements = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  for (const match of statements.matchAll(CREATE_OBJECT_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }

  return [...names];
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function readAppliedMigrations(client: Client): Promise<Set<string>> {
  const rows = await client.execute('SELECT name FROM schema_migrations');
  return new Set(rows.rows.map((row) => String(row.name)));
}

async function readExistingObjects(client: Client): Promise<Set<string>> {
  const rows = await client.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
  );
  return new Set(rows.rows.map((row) => String(row.name)));
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
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

  const applied = await readAppliedMigrations(client);

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

      // El caso típico: el esquema existe (dump, intento previo interrumpido,
      // DB compartida) pero el registro de migraciones está vacío.
      const hint = isAlreadyExistsError(error)
        ? '. El esquema ya existe pero schema_migrations no lo registra: ' +
          'ejecuta `npm run db:baseline` o recrea la base de datos (ver README)'
        : '';

      throw new Error(`La migración ${file} falló y fue revertida${hint}`, {
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

/**
 * Marca como aplicadas las migraciones cuyo esquema ya está presente, sin
 * ejecutar su SQL. Sirve para reconciliar una DB restaurada desde un dump (o
 * creada a mano) con un `schema_migrations` vacío.
 *
 * Solo registra una migración si **todos** los objetos que crea existen ya; si
 * falta alguno la deja en `pending` para revisión manual. Con `dryRun` no
 * escribe nada.
 */
export async function baselineMigrations(
  client: Client,
  options: BaselineOptions = {},
): Promise<BaselineResult> {
  const dryRun = options.dryRun === true;

  await client.execute(CREATE_MIGRATIONS_TABLE);

  const applied = await readAppliedMigrations(client);
  const existing = await readExistingObjects(client);

  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = await listMigrationFiles(migrationsDir);

  const recorded: string[] = [];
  const pending: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const objects = extractCreatedObjects(sql);
    const complete =
      objects.length > 0 && objects.every((name) => existing.has(name));

    if (!complete) {
      pending.push(file);
      continue;
    }

    if (!dryRun) {
      await client.execute({
        sql:
          'INSERT INTO schema_migrations (name) VALUES (?) ' +
          'ON CONFLICT(name) DO NOTHING',
        args: [file],
      });
      logger.info({ migration: file }, 'migration_baselined');
    }

    recorded.push(file);
  }

  return { dryRun, recorded, pending };
}
