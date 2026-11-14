import type { Client, InStatement } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAliasCache } from '../cache/alias-cache.js';
import {
  createTempDatabase,
  type TempDatabase,
} from '../testing/temp-db.js';
import { createLinkService, type LinkService } from './service.js';

const databases: TempDatabase[] = [];

async function setup(
  options: {
    current?: { value: Date };
    maxActiveLinksPerIp?: number;
    withCache?: boolean;
    clickBuffer?: { record: (alias: string, at?: Date) => void };
  } = {},
): Promise<{
  database: TempDatabase;
  service: LinkService;
  client: Client;
  counting: { selects: number; reset: () => void; client: Client };
}> {
  const database = await createTempDatabase();
  databases.push(database);

  let selects = 0;
  const client = database.client;
  const countingClient = {
    execute: (statement: InStatement | string) => {
      const sql =
        typeof statement === 'string' ? statement : statement.sql;

      if (/\bFROM\s+links\b/i.test(sql)) selects += 1;

      return client.execute(statement);
    },
  } as unknown as Client;

  const current = options.current ?? { value: new Date() };
  const cache = options.withCache ? createAliasCache() : undefined;

  const service = createLinkService({
    db: countingClient,
    now: () => current.value,
    ...(cache ? { cache } : {}),
    ...(options.clickBuffer ? { clickBuffer: options.clickBuffer } : {}),
    ...(options.maxActiveLinksPerIp !== undefined
      ? { maxActiveLinksPerIp: options.maxActiveLinksPerIp }
      : {}),
  });

  return {
    database,
    service,
    client,
    counting: {
      get selects() {
        return selects;
      },
      reset() {
        selects = 0;
      },
      client: countingClient,
    },
  };
}

afterEach(async () => {
  for (const database of databases) {
    await database.cleanup();
  }
  databases.length = 0;
});

describe('caché de resolución', () => {
  it('300 resoluciones producen una sola lectura de la DB', async () => {
    const { service, counting } = await setup({ withCache: true });

    const created = await service.create({
      url: 'https://example.com/cache-caliente',
      alias: 'cache-caliente',
    });
    expect(created.ok).toBe(true);

    counting.reset();

    for (let index = 0; index < 300; index += 1) {
      const resolved = await service.resolve('cache-caliente');
      expect(resolved.ok).toBe(true);
    }

    expect(counting.selects).toBe(1);
  });

  it('vuelve a consultar la DB cuando la entrada vence por TTL', async () => {
    const current = { value: new Date('2026-01-01T00:00:00.000Z') };
    const { service, counting } = await setup({ withCache: true, current });

    await service.create({
      url: 'https://example.com/cache-ttl',
      alias: 'cache-ttl',
    });

    counting.reset();

    await service.resolve('cache-ttl');
    await service.resolve('cache-ttl');
    expect(counting.selects).toBe(1);

    current.value = new Date(
      current.value.getTime() + 60_001,
    );

    await service.resolve('cache-ttl');
    expect(counting.selects).toBe(2);
  });

  it('no cachea los 404: cada intento consulta la DB', async () => {
    const { service, counting } = await setup({ withCache: true });

    counting.reset();

    await service.resolve('no-existe');
    await service.resolve('no-existe');

    expect(counting.selects).toBe(2);
  });

  it('un enlace vencido cacheado responde gone sin redirigir', async () => {
    const current = { value: new Date('2026-01-01T00:00:00.000Z') };
    const { service } = await setup({ withCache: true, current });

    await service.create({
      url: 'https://example.com/cache-caduca',
      alias: 'cache-caduca',
      expiresAt: new Date(current.value.getTime() + 10 * 60_000),
    });

    expect((await service.resolve('cache-caduca')).ok).toBe(true);

    current.value = new Date(
      current.value.getTime() + 11 * 60_000,
    );

    expect(await service.resolve('cache-caduca')).toEqual({
      ok: false,
      reason: 'gone',
    });
  });

  it('registra clics solo en resolve, no en getMetadata', async () => {
    const record = vi.fn();
    const { service } = await setup({ clickBuffer: { record } });

    await service.create({
      url: 'https://example.com/clics',
      alias: 'clics-servicio',
    });

    await service.getMetadata('clics-servicio');
    expect(record).not.toHaveBeenCalled();

    await service.resolve('clics-servicio');
    expect(record).toHaveBeenCalledWith(
      'clics-servicio',
      expect.any(Date),
    );
  });
});

describe('dedupe y cuota por IP', () => {
  it('devuelve el alias existente para la misma URL e IP dentro de 24 h', async () => {
    const { service, client } = await setup();

    const first = await service.create({
      url: 'https://example.com/dedupe',
      createdIpHash: 'ip-hash-a',
    });
    const second = await service.create({
      url: 'https://example.com/dedupe',
      createdIpHash: 'ip-hash-a',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.link.alias).toBe(first.link.alias);

    const count = await client.execute(
      'SELECT COUNT(*) AS total FROM links',
    );
    expect(Number(count.rows[0]?.total)).toBe(1);
  });

  it('no deduplica entre IPs distintas ni pasadas 24 h', async () => {
    const current = { value: new Date('2026-01-01T00:00:00.000Z') };
    const { service } = await setup({ current });

    const first = await service.create({
      url: 'https://example.com/dedupe-ip',
      createdIpHash: 'ip-hash-a',
    });
    const otherIp = await service.create({
      url: 'https://example.com/dedupe-ip',
      createdIpHash: 'ip-hash-b',
    });

    current.value = new Date(
      current.value.getTime() + 24 * 60 * 60_000 + 1,
    );

    const nextDay = await service.create({
      url: 'https://example.com/dedupe-ip',
      createdIpHash: 'ip-hash-a',
    });

    expect(first.ok && otherIp.ok && nextDay.ok).toBe(true);
    if (!first.ok || !otherIp.ok || !nextDay.ok) return;

    expect(otherIp.link.alias).not.toBe(first.link.alias);
    expect(nextDay.link.alias).not.toBe(first.link.alias);
  });

  it('no deduplica si la persona pidió un alias personalizado', async () => {
    const { service } = await setup();

    const generated = await service.create({
      url: 'https://example.com/custom-dedupe',
      createdIpHash: 'ip-hash-a',
    });
    const custom = await service.create({
      url: 'https://example.com/custom-dedupe',
      alias: 'mi-alias-propio',
      createdIpHash: 'ip-hash-a',
    });

    expect(generated.ok).toBe(true);
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.link.alias).toBe('mi-alias-propio');
  });

  it('rechaza con quota_exceeded al superar el máximo de activos', async () => {
    const { service, client } = await setup({ maxActiveLinksPerIp: 2 });

    const first = await service.create({
      url: 'https://example.com/cuota-1',
      createdIpHash: 'ip-hash-cuota',
    });
    const second = await service.create({
      url: 'https://example.com/cuota-2',
      createdIpHash: 'ip-hash-cuota',
    });
    const third = await service.create({
      url: 'https://example.com/cuota-3',
      createdIpHash: 'ip-hash-cuota',
    });
    const otherIp = await service.create({
      url: 'https://example.com/cuota-4',
      createdIpHash: 'ip-hash-otra',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual(
      expect.objectContaining({ ok: false, code: 'quota_exceeded' }),
    );
    expect(otherIp.ok).toBe(true);

    // Deshabilitar un enlace libera su cupo porque ya no está activo.
    await client.execute({
      sql: `UPDATE links
               SET disabled_at = ?, disabled_reason = ?
             WHERE alias = ?`,
      args: [
        new Date().toISOString(),
        'test',
        first.ok ? first.link.alias : '',
      ],
    });

    const fourth = await service.create({
      url: 'https://example.com/cuota-5',
      createdIpHash: 'ip-hash-cuota',
    });

    expect(fourth.ok).toBe(true);
  });

  it('los vencidos no cuentan para la cuota', async () => {
    const current = { value: new Date('2026-01-01T00:00:00.000Z') };
    const { service } = await setup({
      current,
      maxActiveLinksPerIp: 1,
    });

    await service.create({
      url: 'https://example.com/cuota-vence',
      createdIpHash: 'ip-hash-vence',
      expiresAt: new Date(current.value.getTime() + 5 * 60_000),
    });

    const blocked = await service.create({
      url: 'https://example.com/cuota-vence-2',
      createdIpHash: 'ip-hash-vence',
    });
    expect(blocked.ok).toBe(false);

    current.value = new Date(
      current.value.getTime() + 6 * 60_000,
    );

    const afterExpiry = await service.create({
      url: 'https://example.com/cuota-vence-3',
      createdIpHash: 'ip-hash-vence',
    });

    expect(afterExpiry.ok).toBe(true);
  });
});
