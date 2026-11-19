import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import type { Express } from 'express';
import { config } from '../../src/config.js';
import { FORM_HONEYPOT_FIELD, FORM_TOKEN_FIELD } from '../../src/security/form-token.js';
import {
  ABUSE_EMAIL,
  createTestApp,
  formBody,
  type TestApp,
} from '../helpers/test-app.js';

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
    expect(response.text).toContain('name="_formToken"');
    expect(response.text).toContain('name="alias"');
    expect(response.text).toContain('name="expiresAt"');
    expect(response.text).toContain('name="website"');
  });

  it('acepta el token honeypot que renderiza GET /', async () => {
    const home = await request(app)
      .get('/')
      .set('Accept', 'text/html');
    const match = /name="_formToken" value="([^"]+)"/.exec(home.text);

    expect(match?.[1]).toMatch(/^\d{13}\.[a-f0-9]{64}$/);

    const response = await request(app)
      .post('/links')
      .type('form')
      .send({
        url: 'https://example.com/token-renderizado',
        [FORM_TOKEN_FIELD]: match?.[1] ?? '',
        [FORM_HONEYPOT_FIELD]: '',
      });

    expect(response.status).toBe(303);
  });

  it('crea por formulario con 303 y muestra la tarjeta', async () => {
    const created = await request(app)
      .post('/links')
      .type('form')
      .send(formBody({ url: 'https://example.com/formulario' }));

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

  it('acepta alias propio y caducidad desde el formulario', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);

    const created = await request(app)
      .post('/links')
      .type('form')
      .send(
        formBody({
          url: 'https://example.com/formulario-avanzado',
          alias: 'alias-form',
          expiresAt,
        }),
      );

    expect(created.status).toBe(303);
    expect(created.headers.location).toBe('/?created=alias-form');

    const metadata = await request(app).get('/api/v1/links/alias-form');

    expect(metadata.status).toBe(200);
    expect(metadata.body.alias).toBe('alias-form');
    expect(metadata.body.expiresAt).toMatch(/Z$/);
  });

  it('devuelve 409 si se repite el alias desde el formulario', async () => {
    const first = await request(app)
      .post('/links')
      .type('form')
      .send(
        formBody({
          url: 'https://example.com/form-alias-1',
          alias: 'form-repetido',
        }),
      );
    const second = await request(app)
      .post('/links')
      .type('form')
      .send(
        formBody({
          url: 'https://example.com/form-alias-2',
          alias: 'form-repetido',
        }),
      );

    expect(first.status).toBe(303);
    expect(second.status).toBe(409);
    expect(second.text).toContain('ya está en uso');
  });

  it('devuelve 422 y escapa la URL enviada cuando es inválida', async () => {
    const malicious = '<script>alert(1)</script>';
    const response = await request(app)
      .post('/links')
      .type('form')
      .send(formBody({ url: malicious }));

    expect(response.status).toBe(422);
    expect(response.text).not.toContain(malicious);
    expect(response.text).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(response.text).toContain('No se pudo crear el enlace');
  });

  it('rechaza una caducidad de formulario mal formada', async () => {
    const response = await request(app)
      .post('/links')
      .type('form')
      .send(
        formBody({
          url: 'https://example.com/fecha-mala',
          expiresAt: '2026-02-31T10:00',
        }),
      );

    expect(response.status).toBe(422);
    expect(response.text).toContain('La fecha de caducidad no es válida');
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
