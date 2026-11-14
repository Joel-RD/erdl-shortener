import { afterEach, describe, expect, it } from 'vitest';
import {
  createBlocklist,
  matchesBlockedDomain,
  normalizeBlocklistDomain,
  type Blocklist,
} from './blocklist.js';
import {
  createTempDatabase,
  type TempDatabase,
} from '../testing/temp-db.js';

const databases: TempDatabase[] = [];

async function setup(options: {
  now?: { value: Date };
  ownDomain?: string;
  cacheTtlMs?: number;
} = {}): Promise<{
  blocklist: Blocklist;
  database: TempDatabase;
  clock: { value: Date };
}> {
  const database = await createTempDatabase();
  databases.push(database);

  const clock = options.now ?? { value: new Date('2026-01-01T00:00:00.000Z') };
  const blocklist = createBlocklist({
    db: database.client,
    now: () => clock.value,
    ...(options.ownDomain ? { ownDomain: options.ownDomain } : {}),
    ...(options.cacheTtlMs !== undefined
      ? { cacheTtlMs: options.cacheTtlMs }
      : {}),
  });

  return { blocklist, database, clock };
}

afterEach(async () => {
  for (const database of databases) {
    await database.cleanup();
  }
  databases.length = 0;
});

describe('normalizeBlocklistDomain', () => {
  it('extrae el dominio registrable de una URL o de un subdominio', () => {
    expect(normalizeBlocklistDomain('https://a.b.Example.CO.UK/ruta')).toBe(
      'example.co.uk',
    );
    expect(normalizeBlocklistDomain('sub.example.com.')).toBe('example.com');
    expect(normalizeBlocklistDomain('*.example.com')).toBe('example.com');
    expect(normalizeBlocklistDomain('example.com:8080/ruta')).toBe(
      'example.com',
    );
    expect(normalizeBlocklistDomain('user@example.com')).toBe('example.com');
  });

  it('rechaza IPs y cadenas sin dominio público', () => {
    expect(normalizeBlocklistDomain('127.0.0.1')).toBeNull();
    expect(normalizeBlocklistDomain('[::1]')).toBeNull();
    expect(normalizeBlocklistDomain('localhost')).toBeNull();
    expect(normalizeBlocklistDomain('')).toBeNull();
  });
});

describe('matchesBlockedDomain', () => {
  it('cubre subdominios sin confundir sufijos parecidos', () => {
    const blocked = new Set(['example.co.uk']);

    expect(matchesBlockedDomain('a.b.example.co.uk', blocked)).toBe(true);
    expect(matchesBlockedDomain('example.co.uk', blocked)).toBe(true);
    expect(matchesBlockedDomain('notexample.co.uk', blocked)).toBe(false);
  });
});

describe('createBlocklist', () => {
  it('bloquea la semilla y el dominio propio, con sus subdominios', async () => {
    const { blocklist } = await setup({ ownDomain: 'short.test' });

    await expect(blocklist.isBlocked('bit.ly')).resolves.toBe(true);
    await expect(blocklist.isBlocked('www.bit.ly')).resolves.toBe(true);
    await expect(blocklist.isBlocked('short.test')).resolves.toBe(true);
    await expect(blocklist.isBlocked('sub.short.test')).resolves.toBe(true);
    await expect(blocklist.isBlocked('example.com')).resolves.toBe(false);
  });

  it('cachea la DB 60 s y recarga al vencer el TTL', async () => {
    const { blocklist, database, clock } = await setup();

    await expect(blocklist.isBlocked('nuevo-bloqueo.test')).resolves.toBe(
      false,
    );

    await database.client.execute({
      sql: `INSERT INTO blocked_domains (domain, source, enabled)
            VALUES ('nuevo-bloqueo.test', 'manual', 1)`,
    });

    // La caché todavía no lo ve.
    await expect(blocklist.isBlocked('nuevo-bloqueo.test')).resolves.toBe(
      false,
    );

    clock.value = new Date(clock.value.getTime() + 60_001);

    await expect(blocklist.isBlocked('nuevo-bloqueo.test')).resolves.toBe(
      true,
    );
  });

  it('el alta manual invalida la caché de inmediato', async () => {
    const { blocklist } = await setup();

    await expect(blocklist.isBlocked('alta-caliente.test')).resolves.toBe(
      false,
    );

    const added = await blocklist.addManual('Sub.Alta-Caliente.Test');

    expect(added).toEqual({
      domain: 'alta-caliente.test',
      enabled: true,
    });
    await expect(blocklist.isBlocked('alta-caliente.test')).resolves.toBe(
      true,
    );
  });

  it('permite desactivar una entrada sin borrarla', async () => {
    const { blocklist, database } = await setup();

    await blocklist.addManual('se-apaga.test', true);
    await expect(blocklist.isBlocked('se-apaga.test')).resolves.toBe(true);

    await blocklist.addManual('se-apaga.test', false);
    await expect(blocklist.isBlocked('se-apaga.test')).resolves.toBe(false);

    const row = await database.client.execute({
      sql: 'SELECT enabled FROM blocked_domains WHERE domain = ?',
      args: ['se-apaga.test'],
    });

    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0]?.enabled)).toBe(0);
  });

  it('una fila desactivada también apaga una entrada de la semilla', async () => {
    const { blocklist } = await setup();

    await expect(blocklist.isBlocked('bit.ly')).resolves.toBe(true);

    await blocklist.addManual('bit.ly', false);

    await expect(blocklist.isBlocked('bit.ly')).resolves.toBe(false);

    await blocklist.addManual('bit.ly', true);

    await expect(blocklist.isBlocked('bit.ly')).resolves.toBe(true);
  });
});
