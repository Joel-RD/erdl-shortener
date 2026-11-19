import { afterEach, describe, expect, it } from 'vitest';
import { createLinkService } from '../../../src/domain/links/service.js';
import { createLinksRepository } from '../../../src/infra/db/links-repository.js';
import {
  createTempDatabase,
  type TempDatabase,
} from '../../helpers/temp-db.js';
import {
  anonymizeOldIpHashes,
  createRetentionJob,
} from '../../../src/infra/jobs/retention.js';

const databases: TempDatabase[] = [];

async function setup(): Promise<TempDatabase> {
  const database = await createTempDatabase();
  databases.push(database);
  return database;
}

afterEach(async () => {
  for (const database of databases) {
    await database.cleanup();
  }
  databases.length = 0;
});

describe('anonymizeOldIpHashes', () => {
  it('pone created_ip_hash en NULL solo a las filas pasadas de umbral', async () => {
    const database = await setup();
    const now = new Date('2026-06-01T00:00:00.000Z');

    await database.client.execute({
      sql: `INSERT INTO links
              (alias, url, url_hash, domain, created_ip_hash, created_at)
            VALUES
              ('viejo-1', 'https://example.com/viejo', 'h1', 'example.com',
               'ip-hash-vieja', '2026-05-30T00:00:00.000Z'),
              ('nuevo-1', 'https://example.com/nuevo', 'h2', 'example.com',
               'ip-hash-nueva', '2026-05-31T23:59:00.000Z')`,
    });

    const changed = await anonymizeOldIpHashes({
      db: database.client,
      retentionMs: 60 * 60 * 1000,
      now: () => now,
    });

    expect(changed).toBe(1);

    const result = await database.client.execute(
      'SELECT alias, created_ip_hash FROM links ORDER BY alias',
    );
    const rows = result.rows.map((row) => ({
      alias: String(row.alias),
      hash: row.created_ip_hash === null ? null : String(row.created_ip_hash),
    }));

    expect(rows).toEqual([
      { alias: 'nuevo-1', hash: 'ip-hash-nueva' },
      { alias: 'viejo-1', hash: null },
    ]);
  });

  it('acepta un umbral en días para producción', async () => {
    const database = await setup();
    const now = new Date('2026-06-01T00:00:00.000Z');

    await database.client.execute({
      sql: `INSERT INTO links
              (alias, url, url_hash, domain, created_ip_hash, created_at)
            VALUES ('hace-46-dias', 'https://example.com/a', 'h1',
                    'example.com', 'hash', '2026-04-15T00:00:00.000Z')`,
    });

    expect(
      await anonymizeOldIpHashes({
        db: database.client,
        retentionDays: 45,
        now: () => now,
      }),
    ).toBe(1);
  });

  it('tras anonimizar, la IP deja de contar para la cuota', async () => {
    const database = await setup();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const service = createLinkService({
      repository: createLinksRepository(database.client),
      now: () => now,
      maxActiveLinksPerIp: 1,
    });

    await database.client.execute({
      sql: `INSERT INTO links
              (alias, url, url_hash, domain, created_ip_hash, created_at)
            VALUES ('cuota-vieja', 'https://example.com/cuota', 'h1',
                    'example.com', 'ip-hash-cuota', '2026-04-01T00:00:00.000Z')`,
    });

    const blocked = await service.create({
      url: 'https://example.com/otra',
      createdIpHash: 'ip-hash-cuota',
    });

    expect(blocked).toEqual(
      expect.objectContaining({ ok: false, code: 'quota_exceeded' }),
    );

    await anonymizeOldIpHashes({
      db: database.client,
      retentionDays: 45,
      now: () => now,
    });

    const allowed = await service.create({
      url: 'https://example.com/otra',
      createdIpHash: 'ip-hash-cuota',
    });

    expect(allowed.ok).toBe(true);
  });
});

describe('createRetentionJob', () => {
  it('start ejecuta una pasada y stop detiene el timer', async () => {
    const database = await setup();
    const now = new Date('2026-06-01T00:00:00.000Z');

    await database.client.execute({
      sql: `INSERT INTO links
              (alias, url, url_hash, domain, created_ip_hash, created_at)
            VALUES ('job-viejo', 'https://example.com/job', 'h1',
                    'example.com', 'hash-job', '2026-04-01T00:00:00.000Z')`,
    });

    const job = createRetentionJob({
      db: database.client,
      retentionDays: 45,
      now: () => now,
      intervalMs: 60_000,
    });

    expect(await job.runOnce()).toBe(1);

    // start/stop no deben dejar timers vivos ni lanzar errores.
    job.start();
    await job.stop();

    const result = await database.client.execute(
      "SELECT created_ip_hash FROM links WHERE alias = 'job-viejo'",
    );
    expect(result.rows[0]?.created_ip_hash).toBeNull();
  });
});
