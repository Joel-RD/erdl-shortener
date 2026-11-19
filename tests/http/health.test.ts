import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let context: TestApp;
let app: Express;

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
});

afterAll(async () => {
  await context.cleanup();
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

  it('GET /ready comprueba la base de datos', async () => {
    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
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
    // HSTS solo se activa en producción (HTTPS).
    expect(response.headers['strict-transport-security']).toBeUndefined();
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
