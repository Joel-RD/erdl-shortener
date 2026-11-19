import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createLogger } from '../../src/logger.js';
import { createTestApp, UNLIMITED, type TestApp } from '../helpers/test-app.js';

let context: TestApp;
let app: Express;

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
});

afterAll(async () => {
  await context.cleanup();
});

describe('regresiones', () => {
  it('los logs HTTP no contienen la IP del cliente en claro', async () => {
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logged = await createTestApp({
      logger: createLogger({ level: 'info', destination: sink }),
      limits: {
        createIp: UNLIMITED,
        createGlobal: [],
        redirectIp: [],
        requestIp: UNLIMITED,
      },
    });

    try {
      await request(logged.app)
        .post('/api/v1/links')
        .set('X-Forwarded-For', '203.0.113.77')
        .set('Referer', 'https://privado.example/ruta')
        .send({ url: 'https://example.com/sin-ip-en-logs' });

      expect(output).toContain('"method":"POST"');
      expect(output).not.toContain('remoteAddress');
      expect(output).not.toContain('remotePort');
      expect(output).not.toContain('127.0.0.1"');
      expect(output).not.toContain('::ffff:127.0.0.1');
      expect(output).not.toContain('203.0.113.77');
      expect(output).not.toContain('privado.example');
    } finally {
      await logged.cleanup();
    }
  });

  it('la API rechaza formularios urlencoded con 415 y no crea nada', async () => {
    const response = await request(app)
      .post('/api/v1/links')
      .type('form')
      .send({ url: 'https://example.com/urlencoded' });

    expect(response.status).toBe(415);
    expect(response.body.error).toBe('unsupported_media_type');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('un HEAD no suma clics y la tarjeta creada no se indexa', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com/head-sin-clic' });
    const alias = String(created.body.alias);

    const head = await request(app).head(`/${alias}`);
    await context.runtime.clickBuffer.flush();

    const metadata = await request(app).get(`/api/v1/links/${alias}`);

    expect(head.status).toBe(302);
    expect(metadata.body.clicks).toBe(0);

    const card = await request(app)
      .get(`/?created=${alias}`)
      .set('Accept', 'text/html');

    expect(card.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
