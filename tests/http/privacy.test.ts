import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import {
  ABUSE_EMAIL,
  createTestApp,
  type TestApp,
} from '../helpers/test-app.js';

let context: TestApp;
let app: Express;

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
});

afterAll(async () => {
  await context.cleanup();
});

describe('GET /privacidad', () => {
  it('sirve la política en HTML con la retención configurada', async () => {
    const response = await request(app).get('/privacidad');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('Privacidad · erdl');
    expect(response.text).toContain('a los 45 días');
    expect(response.text).toContain('HMAC-SHA256');
    expect(response.text).toContain(ABUSE_EMAIL);
  });

  it('enlaza la política desde el pie y desde el formulario', async () => {
    const [privacy, home] = await Promise.all([
      request(app).get('/privacidad'),
      request(app).get('/'),
    ]);

    expect(privacy.text).toContain('<a href="/privacidad">Privacidad</a>');
    expect(home.text).toContain(
      '<a href="/privacidad">Cómo tratamos tus datos</a>',
    );
  });

  it('conserva la CSP estricta y un solo script externo', async () => {
    const response = await request(app).get('/privacidad');

    expect(response.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    expect(response.text.match(/<script\b[^>]*>/g)).toEqual([
      '<script src="/app.js" defer>',
    ]);
  });

  it('reserva el alias para que no pueda ser creado por un enlace', async () => {
    const response = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://example.com', alias: 'privacidad' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('alias_reserved');
  });
});
