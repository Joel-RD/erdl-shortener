import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase, createDatabaseClient } from '../../../src/infra/db/client.js';
import {
  baselineMigrations,
  DEFAULT_MIGRATIONS_DIR,
  extractCreatedObjects,
  runMigrations,
} from '../../../src/infra/db/migrate.js';

const tempDirs: string[] = [];
const clients: Client[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'erdl-db-'));
  tempDirs.push(dir);
  return dir;
}

async function createTempDatabase(): Promise<Client> {
  const dir = await createTempDir();
  const client = createDatabaseClient({
    url: pathToFileURL(join(dir, 'test.db')).href,
  });

  clients.push(client);
  await configureDatabase(client);

  return client;
}

async function tableNames(client: Client): Promise<string[]> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );

  return result.rows.map((row) => String(row.name));
}

/** Aplica el SQL de una migración sin pasar por `runMigrations`. */
async function applyMigrationFile(client: Client, file: string): Promise<void> {
  const sql = await readFile(join(DEFAULT_MIGRATIONS_DIR, file), 'utf8');
  await client.executeMultiple(sql);
}

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe('runMigrations', () => {
  it('crea las tablas del esquema inicial en una DB temporal', async () => {
    const client = await createTempDatabase();

    const applied = await runMigrations(client);

    expect(applied).toEqual(['001_init.sql', '002_retention_index.sql']);
    expect(await tableNames(client)).toEqual(
      expect.arrayContaining([
        'blocked_domains',
        'links',
        'schema_migrations',
      ]),
    );
  });

  it('crea los índices que responden a dedupe, cuota, dominio y expiración', async () => {
    const client = await createTempDatabase();
    await runMigrations(client);

    const result = await client.execute(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'links'
         AND name NOT LIKE 'sqlite_autoindex%'
       ORDER BY name`,
    );
    const indexes = result.rows.map((row) => String(row.name));

    expect(indexes).toEqual([
      'idx_links_created_ip_hash',
      'idx_links_dedupe',
      'idx_links_domain',
      'idx_links_expires_at',
      'idx_links_retention',
    ]);
  });

  it('es idempotente: la segunda ejecución no aplica nada', async () => {
    const client = await createTempDatabase();

    await runMigrations(client);
    const appliedAgain = await runMigrations(client);

    expect(appliedAgain).toEqual([]);

    const count = await client.execute(
      'SELECT COUNT(*) AS total FROM schema_migrations',
    );
    expect(Number(count.rows[0]?.total)).toBe(2);
  });

  it('deja la DB local en modo WAL', async () => {
    const client = await createTempDatabase();

    const result = await client.execute('PRAGMA journal_mode');

    expect(String(result.rows[0]?.journal_mode).toLowerCase()).toBe('wal');
  });

  it('revierte una migración con SQL inválido y no la registra', async () => {
    const client = await createTempDatabase();
    const migrationsDir = await createTempDir();
    await writeFile(
      join(migrationsDir, '001_rota.sql'),
      'CREATE TABLE parcial (id INTEGER); CREATE TABLE parcial (id INTEGER);',
      'utf8',
    );

    await expect(
      runMigrations(client, { migrationsDir }),
    ).rejects.toThrow(/001_rota\.sql/);

    expect(await tableNames(client)).not.toContain('parcial');

    const count = await client.execute(
      'SELECT COUNT(*) AS total FROM schema_migrations',
    );
    expect(Number(count.rows[0]?.total)).toBe(0);
  });

  it('impide reutilizar un alias ya registrado', async () => {
    const client = await createTempDatabase();
    await runMigrations(client);

    const insert = `INSERT INTO links (alias, url, url_hash, domain)
                    VALUES ('abc1234', 'https://example.com', 'hash', 'example.com')`;

    await client.execute(insert);
    await expect(client.execute(insert)).rejects.toThrow();
  });

  it('arranca sobre un esquema preexistente sin registro de migraciones', async () => {
    const client = await createTempDatabase();

    // Simula una DB restaurada desde un dump: el esquema está, el ledger no.
    await applyMigrationFile(client, '001_init.sql');
    await applyMigrationFile(client, '002_retention_index.sql');

    const applied = await runMigrations(client);

    expect(applied).toEqual(['001_init.sql', '002_retention_index.sql']);

    const count = await client.execute(
      'SELECT COUNT(*) AS total FROM schema_migrations',
    );
    expect(Number(count.rows[0]?.total)).toBe(2);
  });

  it('baseline registra lo ya presente y no ejecuta su SQL', async () => {
    const client = await createTempDatabase();
    await applyMigrationFile(client, '001_init.sql');

    const preview = await baselineMigrations(client, { dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.recorded).toEqual(['001_init.sql']);
    expect(preview.pending).toEqual(['002_retention_index.sql']);

    const before = await client.execute(
      'SELECT COUNT(*) AS total FROM schema_migrations',
    );
    expect(Number(before.rows[0]?.total)).toBe(0);

    const result = await baselineMigrations(client);

    expect(result.dryRun).toBe(false);
    expect(result.recorded).toEqual(['001_init.sql']);
    expect(result.pending).toEqual(['002_retention_index.sql']);

    // Al completar el esquema, el siguiente baseline sí puede registrarlo.
    await applyMigrationFile(client, '002_retention_index.sql');

    const completed = await baselineMigrations(client);

    expect(completed.recorded).toEqual(['002_retention_index.sql']);
    expect(completed.pending).toEqual([]);
    expect(await runMigrations(client)).toEqual([]);
  });

  it('baseline deja pendiente una migración con el esquema incompleto', async () => {
    const client = await createTempDatabase();

    // Solo existe `links`: faltan índices y `blocked_domains`.
    await client.execute('CREATE TABLE links (alias TEXT PRIMARY KEY)');

    const result = await baselineMigrations(client);

    expect(result.recorded).toEqual([]);
    expect(result.pending).toEqual([
      '001_init.sql',
      '002_retention_index.sql',
    ]);
  });

  it('sugiere el baseline cuando el esquema ya existe sin registro', async () => {
    const client = await createTempDatabase();
    const migrationsDir = await createTempDir();

    await client.execute('CREATE TABLE choque (id INTEGER)');
    await writeFile(
      join(migrationsDir, '001_choque.sql'),
      'CREATE TABLE choque (id INTEGER);',
      'utf8',
    );

    await expect(
      runMigrations(client, { migrationsDir }),
    ).rejects.toThrow(/db:baseline/);
  });

  it('extractCreatedObjects reconoce tablas e índices del DDL', () => {
    expect(
      extractCreatedObjects(`
        CREATE TABLE IF NOT EXISTS links (alias TEXT PRIMARY KEY);
        CREATE INDEX idx_links_domain ON links (domain);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unico ON links (alias);
        -- CREATE TABLE comentada (no debería contar);
      `),
    ).toEqual(['links', 'idx_links_domain', 'idx_unico']);
  });
});
