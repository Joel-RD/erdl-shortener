import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase, createDatabaseClient } from './client.js';
import { runMigrations } from './migrate.js';

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

    expect(applied).toEqual(['001_init.sql']);
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
    expect(Number(count.rows[0]?.total)).toBe(1);
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
});
