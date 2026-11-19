import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import type { Express } from 'express';
import { config } from '../../src/config.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let context: TestApp;
let app: Express;
let db: Client;

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
  db = context.db;
});

afterAll(async () => {
  await context.cleanup();
});

describe('API de enlaces', () => {
  it('crea un enlace, redirige y expone metadata con 0 clics', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com/desde-api' });

    expect(created.status).toBe(201);
    expect(created.body.alias).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(created.body.url).toBe('https://example.com/desde-api');
    expect(created.body.clicks).toBe(0);
    expect(created.body.expiresAt).toBeNull();
    expect(created.body.shortUrl).toBe(
      `${config.baseUrl}/${created.body.alias}`,
    );
    expect(created.headers.location).toBe(
      `/api/v1/links/${created.body.alias}`,
    );

    const alias = String(created.body.alias);

    const redirect = await request(app).get(`/${alias}`);

    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/desde-api');
    expect(redirect.headers['cache-control']).toBe('no-store');

    const metadata = await request(app).get(`/api/v1/links/${alias}`);

    expect(metadata.status).toBe(200);
    expect(metadata.headers['cache-control']).toBe('no-store');
    expect(metadata.body).toEqual(
      expect.objectContaining({
        alias,
        url: 'https://example.com/desde-api',
        clicks: 0,
        shortUrl: `${config.baseUrl}/${alias}`,
      }),
    );
  });

  it('acepta alias personalizado y devuelve 409 si se repite', async () => {
    const first = await request(app)
      .post('/api/v1/links')
      .send({
        url: 'https://example.com/uno',
        alias: 'repetido-api',
      });

    const second = await request(app)
      .post('/api/v1/links')
      .send({
        url: 'https://example.com/dos',
        alias: 'repetido-api',
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(
      expect.objectContaining({ error: 'alias_taken' }),
    );
  });

  it('valida URL, alias reservado y cuerpo mal formado', async () => {
    const invalidUrl = await request(app)
      .post('/api/v1/links')
      .send({ url: 'javascript:alert(1)' });

    const reserved = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com', alias: 'api' });

    const malformed = await request(app)
      .post('/api/v1/links')
      .send({ expiresAt: 'mañana' });

    const unknownField = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com', admin: true });

    expect(invalidUrl.status).toBe(400);
    expect(invalidUrl.body.error).toBe('url_scheme');
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toBe('alias_reserved');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_request');
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toBe('invalid_request');
  });

  it('acepta una expiración válida y rechaza fechas fuera de rango', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const valid = await request(app)
      .post('/api/v1/links')
      .send({
        url: 'https://example.com/api-expira',
        alias: 'api-expira',
        expiresAt,
      });
    const tooSoon = await request(app)
      .post('/api/v1/links')
      .send({
        url: 'https://example.com/api-pronto',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(valid.status).toBe(201);
    expect(valid.body.expiresAt).toBe(expiresAt);
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.error).toBe('expiration_invalid');
  });

  it('devuelve 410 para enlaces deshabilitados y vencidos', async () => {
    await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com/retirado', alias: 'retirado-api' });

    await db.execute({
      sql: `UPDATE links
            SET disabled_at = ?, disabled_reason = ?
            WHERE alias = ?`,
      args: [new Date().toISOString(), 'abuso', 'retirado-api'],
    });

    await db.execute({
      sql: `INSERT INTO links
              (alias, url, url_hash, domain, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        'vencido-api',
        'https://example.com/vencido',
        'hash-vencido',
        'example.com',
        '2020-01-01T00:00:00.000Z',
        '2020-01-02T00:00:00.000Z',
      ],
    });

    const disabledRedirect = await request(app).get('/retirado-api');
    const expiredRedirect = await request(app).get('/vencido-api');
    const expiredMetadata = await request(app).get(
      '/api/v1/links/vencido-api',
    );

    expect(disabledRedirect.status).toBe(410);
    expect(disabledRedirect.body).toEqual({ error: 'gone' });
    expect(expiredRedirect.status).toBe(410);
    expect(expiredMetadata.status).toBe(410);
    expect(expiredMetadata.body).toEqual({ error: 'gone' });
  });

  it('devuelve 404 para metadata de un alias inexistente', async () => {
    const response = await request(app).get('/api/v1/links/no-existe');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });

  it('deduplica la misma URL de la misma IP y guarda solo un HMAC', async () => {
    const url = 'https://example.com/dedupe-app';

    const first = await request(app)
      .post('/api/v1/links')
      .send({ url });
    const second = await request(app)
      .post('/api/v1/links')
      .send({ url });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.alias).toBe(first.body.alias);

    const rows = await db.execute({
      sql: 'SELECT created_ip_hash FROM links WHERE url = ?',
      args: [url],
    });

    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]?.created_ip_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rows.rows[0]?.created_ip_hash)).not.toContain('127.0.0.1');
  });

  it('persiste los clics pendientes al vaciar el buffer', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com/clics-app' });
    const alias = String(created.body.alias);

    await request(app).get(`/${alias}`);
    await request(app).get(`/${alias}`);

    const beforeFlush = await request(app).get(`/api/v1/links/${alias}`);
    expect(beforeFlush.body.clicks).toBe(0);

    await context.runtime.clickBuffer.flush();

    const afterFlush = await request(app).get(`/api/v1/links/${alias}`);
    expect(afterFlush.body.clicks).toBe(2);
  });

  it('el dedupe no devuelve un enlace con una caducidad distinta a la pedida', async () => {
    const url = 'https://example.com/dedupe-expiracion-api';
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

    const permanent = await request(app).post('/api/v1/links').send({ url });
    const timed = await request(app)
      .post('/api/v1/links')
      .send({ url, expiresAt });

    expect(permanent.status).toBe(201);
    expect(timed.status).toBe(201);
    expect(timed.body.alias).not.toBe(permanent.body.alias);
    expect(permanent.body.expiresAt).toBeNull();
    expect(timed.body.expiresAt).toBe(expiresAt);
  });
});
