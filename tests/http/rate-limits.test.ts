import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createTestApp, FORM_SECRET, UNLIMITED } from '../helpers/test-app.js';

describe('límites de creación y peticiones', () => {
  it('devuelve 429 con Retry-After al superar 5 creaciones por minuto', async () => {
    const limited = await createTestApp({
      limits: {
        createIp: [{ name: 'minute', limit: 5, windowMs: 60_000 }],
        createGlobal: [],
        redirectIp: [],
        requestIp: UNLIMITED,
      },
    });

    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await request(limited.app)
          .post('/api/v1/links')
          .send({ url: `https://example.com/limite/${index}` });

        expect(response.status).toBe(201);
      }

      const sixth = await request(limited.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/limite/sexto' });

      expect(sixth.status).toBe(429);
      expect(sixth.body).toEqual(
        expect.objectContaining({ error: 'rate_limited' }),
      );
      expect(sixth.headers['retry-after']).toMatch(/^\d+$/);
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(sixth.headers['retry-after'])).toBeLessThanOrEqual(60);
    } finally {
      await limited.cleanup();
    }
  });

  it('un cuerpo inválido no consume la cuota de creación', async () => {
    const quota = await createTestApp({
      limits: {
        createIp: [{ name: 'minute', limit: 1, windowMs: 60_000 }],
        createGlobal: [],
        redirectIp: [],
        requestIp: UNLIMITED,
      },
    });

    try {
      // Zod falla (campo desconocido) antes de tocar el limitador.
      const invalid = await request(quota.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/cuota-invalida', admin: true });
      const first = await request(quota.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/cuota-valida-1' });
      const second = await request(quota.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/cuota-valida-2' });

      expect(invalid.status).toBe(400);
      expect(first.status).toBe(201);
      expect(second.status).toBe(429);
    } finally {
      await quota.cleanup();
    }
  });

  it('frena peticiones mutantes antes de parsear el cuerpo', async () => {
    const flood = await createTestApp({
      limits: {
        createIp: UNLIMITED,
        createGlobal: [],
        redirectIp: [],
        requestIp: [{ name: 'minute', limit: 2, windowMs: 60_000 }],
      },
    });

    try {
      const first = await request(flood.app)
        .post('/api/v1/links')
        .set('Content-Type', 'application/json')
        .send('{"url":');
      const second = await request(flood.app)
        .post('/api/v1/links')
        .set('Content-Type', 'application/json')
        .send('{"url":');
      const third = await request(flood.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/flood' });

      expect(first.status).toBe(400);
      expect(second.status).toBe(400);
      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toMatch(/^\d+$/);
      expect(third.headers['cache-control']).toBe('no-store');
    } finally {
      await flood.cleanup();
    }
  });

  it('la cuota agotada responde 429 con Retry-After estimado', async () => {
    const quota = await createTestApp({
      maxActiveLinksPerIp: 1,
      limits: {
        createIp: UNLIMITED,
        createGlobal: [],
        redirectIp: [],
        requestIp: UNLIMITED,
      },
    });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    try {
      const first = await request(quota.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/cuota-1', expiresAt });
      const second = await request(quota.app)
        .post('/api/v1/links')
        .send({ url: 'https://example.com/cuota-2' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(429);
      expect(second.body.error).toBe('quota_exceeded');
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(600);
    } finally {
      await quota.cleanup();
    }
  });
});

describe('límite de lecturas públicas', () => {
  let lookupApp: Express;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const lookup = await createTestApp({
      formTokenSecret: FORM_SECRET,
      limits: {
        createIp: UNLIMITED,
        createGlobal: [],
        redirectIp: [],
        lookupIp: [{ name: 'test', limit: 3, windowMs: 60_000 }],
        requestIp: UNLIMITED,
      },
    });

    lookupApp = lookup.app;
    cleanup = lookup.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('GET /api/v1/links/:alias responde 429 con Retry-After al excederlo', async () => {
    const statuses: number[] = [];
    let last: request.Response | undefined;

    for (let index = 0; index < 5; index += 1) {
      last = await request(lookupApp).get('/api/v1/links/no-existe-api');
      statuses.push(last.status);
    }

    expect(statuses).toEqual([404, 404, 404, 429, 429]);
    expect(last?.body.error).toBe('rate_limited');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(last?.headers['cache-control']).toBe('no-store');
  });

  it('GET /?created= comparte el límite y la portada sola no cuenta', async () => {
    // El bucket de la prueba anterior ya está agotado (misma IP).
    const limited = await request(lookupApp)
      .get('/?created=no-existe-home')
      .set('Accept', 'text/html');

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.text).toContain('Demasiadas consultas');

    const home = await request(lookupApp)
      .get('/')
      .set('Accept', 'text/html');

    expect(home.status).toBe(200);
  });
});
