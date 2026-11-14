import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Client } from '@libsql/client';
import { createApp } from './app.js';
import { config } from './config.js';
import {
  createTempDatabase,
  type TempDatabase,
} from './testing/temp-db.js';

const ABUSE_EMAIL = 'abuso@example.com';

let app: Express;
let database: TempDatabase;
let db: Client;

beforeAll(async () => {
  database = await createTempDatabase();
  db = database.client;
  app = createApp({ db, abuseContactEmail: ABUSE_EMAIL });
});

afterAll(async () => {
  await database.cleanup();
});

describe('GET /health', () => {
  it('responde 200 con estado ok', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('no revela Express en la cabecera X-Powered-By', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('cabeceras de seguridad', () => {
  it('aplica una CSP estricta sin scripts inline', async () => {
    const response = await request(app).get('/');

    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sirve los estáticos con su tipo correcto', async () => {
    const [css, js, icon, robots] = await Promise.all([
      request(app).get('/styles.css'),
      request(app).get('/app.js'),
      request(app).get('/favicon.svg'),
      request(app).get('/robots.txt'),
    ]);

    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(robots.status).toBe(200);
    expect(robots.headers['content-type']).toMatch(/text\/plain/);
  });
});

describe('rutas desconocidas', () => {
  it('responden 404 en JSON para clientes de API', async () => {
    const response = await request(app).get('/no-existe');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });

  it('responden 404 en HTML para navegadores', async () => {
    const response = await request(app)
      .get('/no-existe')
      .set('Accept', 'text/html');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Ese enlace no existe');
  });
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
});

describe('interfaz SSR', () => {
  it('muestra el formulario, el contacto de abuso y el JS externo', async () => {
    const response = await request(app)
      .get('/')
      .set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('method="post" action="/links"');
    expect(response.text).toContain('src="/app.js"');
    expect(response.text).toContain(`mailto:${ABUSE_EMAIL}`);
    expect(response.text).toContain('href="/styles.css"');
  });

  it('crea por formulario con 303 y muestra la tarjeta', async () => {
    const created = await request(app)
      .post('/links')
      .type('form')
      .send({ url: 'https://example.com/formulario' });

    expect(created.status).toBe(303);
    const location = String(created.headers.location);
    expect(location).toMatch(/^\/\?created=[0-9A-Za-z]{7}$/);

    const alias = location.split('=')[1] ?? '';
    const page = await request(app)
      .get(location)
      .set('Accept', 'text/html');

    expect(page.status).toBe(200);
    expect(page.text).toContain(
      `data-copy="${config.baseUrl}/${alias}"`,
    );
    expect(page.text).toContain('https://example.com/formulario');
    expect(page.text).toContain('Enlace listo');
    expect(page.text).toContain('Copiar enlace');
  });

  it('devuelve 422 y escapa la URL enviada cuando es inválida', async () => {
    const malicious = '<script>alert(1)</script>';
    const response = await request(app)
      .post('/links')
      .type('form')
      .send({ url: malicious });

    expect(response.status).toBe(422);
    expect(response.text).not.toContain(malicious);
    expect(response.text).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(response.text).toContain('No se pudo crear el enlace');
  });

  it('escapa los datos de la tarjeta aunque la DB contenga HTML', async () => {
    await db.execute({
      sql: `INSERT INTO links (alias, url, url_hash, domain)
            VALUES (?, ?, ?, ?)`,
      args: [
        'xss-demo',
        'https://example.com/"><script>alert(1)</script>',
        'hash-xss',
        'example.com',
      ],
    });

    const page = await request(app)
      .get('/?created=xss-demo')
      .set('Accept', 'text/html');

    expect(page.status).toBe(200);
    expect(page.text).not.toContain('<script>alert(1)</script>');
    expect(page.text).toContain(
      'https://example.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('no refleja un alias malicioso del query string', async () => {
    const response = await request(app)
      .get('/?created=%3Cscript%3Ealert(1)%3C%2Fscript%3E')
      .set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('<script>alert(1)</script>');
  });
});
