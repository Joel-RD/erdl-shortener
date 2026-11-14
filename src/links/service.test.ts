import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import {
  createTempDatabase,
  type TempDatabase,
} from '../testing/temp-db.js';
import { createLinkService, type LinkService } from './service.js';

let database: TempDatabase;
let client: Client;
let service: LinkService;
let current: Date;

beforeAll(async () => {
  database = await createTempDatabase();
  client = database.client;
  current = new Date();
  service = createLinkService({ db: client, now: () => current });
});

afterAll(async () => {
  await database.cleanup();
});

describe('createLinkService.create', () => {
  it('crea un alias generado y guarda URL normalizada, hash y dominio', async () => {
    const result = await service.create({
      url: '  HTTPS://Example.COM/recurso?x=1  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.link.alias).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(result.link.url).toBe('https://example.com/recurso?x=1');
    expect(result.link.domain).toBe('example.com');
    expect(result.link.urlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.link.clicks).toBe(0);
    expect(result.link.createdIpHash).toBeNull();
    expect(result.link.disabledAt).toBeNull();
    expect(result.link.expiresAt).toBeNull();
  });

  it('acepta un alias personalizado', async () => {
    const result = await service.create({
      url: 'https://example.com/personalizado',
      alias: 'mi-enlace',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.link.alias).toBe('mi-enlace');
  });

  it('devuelve alias_taken si el alias personalizado ya existe', async () => {
    await service.create({
      url: 'https://example.com/primero',
      alias: 'repetido',
    });

    const result = await service.create({
      url: 'https://example.com/segundo',
      alias: 'repetido',
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'alias_taken' }),
    );
  });

  it('rechaza URLs inválidas sin escribir en la DB', async () => {
    const before = await client.execute('SELECT COUNT(*) AS total FROM links');
    const result = await service.create({ url: 'javascript:alert(1)' });
    const after = await client.execute('SELECT COUNT(*) AS total FROM links');

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'url_scheme' }),
    );
    expect(Number(after.rows[0]?.total)).toBe(Number(before.rows[0]?.total));
  });

  it('rechaza alias reservados y con formato inválido', async () => {
    await expect(
      service.create({ url: 'https://example.com', alias: 'api' }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'alias_reserved' }),
    );

    await expect(
      service.create({ url: 'https://example.com', alias: 'a/b' }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: 'alias_invalid' }),
    );
  });

  it('valida la ventana de expiración de 5 minutos a 1 año', async () => {
    const tooSoon = await service.create({
      url: 'https://example.com/pronto',
      expiresAt: new Date(current.getTime() + 60_000),
    });
    const tooLate = await service.create({
      url: 'https://example.com/tarde',
      expiresAt: new Date(current.getTime() + 366 * 24 * 60 * 60 * 1000),
    });
    const valid = await service.create({
      url: 'https://example.com/valido',
      alias: 'expira-bien',
      expiresAt: new Date(current.getTime() + 10 * 60 * 1000),
    });

    expect(tooSoon).toEqual(
      expect.objectContaining({ ok: false, code: 'expiration_invalid' }),
    );
    expect(tooLate).toEqual(
      expect.objectContaining({ ok: false, code: 'expiration_invalid' }),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.link.expiresAt).toMatch(/Z$/);
  });
});

describe('createLinkService.resolve y getMetadata', () => {
  it('resuelve un enlace existente', async () => {
    const created = await service.create({
      url: 'https://example.com/destino',
      alias: 'resoluble',
    });

    expect(created.ok).toBe(true);

    const resolved = await service.resolve('resoluble');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.link.url).toBe('https://example.com/destino');
  });

  it('distingue not_found de gone para un enlace deshabilitado', async () => {
    await service.create({
      url: 'https://example.com/retirado',
      alias: 'retirado',
    });
    await client.execute({
      sql: `UPDATE links
            SET disabled_at = ?, disabled_reason = ?
            WHERE alias = ?`,
      args: [new Date().toISOString(), 'test', 'retirado'],
    });

    const missing = await service.resolve('no-existe');
    const gone = await service.resolve('retirado');
    const metadata = await service.getMetadata('retirado');

    expect(missing).toEqual({ ok: false, reason: 'not_found' });
    expect(gone).toEqual({ ok: false, reason: 'gone' });
    expect(metadata).toEqual({ ok: false, reason: 'gone' });
  });

  it('marca como gone un enlace vencido sin borrar la fila', async () => {
    const previous = current;
    current = new Date();

    try {
      await service.create({
        url: 'https://example.com/caduca',
        alias: 'caducado',
        expiresAt: new Date(current.getTime() + 10 * 60 * 1000),
      });

      current = new Date(current.getTime() + 11 * 60 * 1000);

      expect(await service.resolve('caducado')).toEqual({
        ok: false,
        reason: 'gone',
      });
    } finally {
      current = previous;
    }
  });
});
