import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import {
  createFormToken,
  FORM_HONEYPOT_FIELD,
  FORM_TOKEN_FIELD,
} from '../../src/security/form-token.js';
import {
  createTestApp,
  FORM_SECRET,
  formBody,
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

describe('abuso del formulario', () => {
  it('rechaza el formulario sin token, demasiado rápido o con honeypot', async () => {
    const strict = await createTestApp({ formTokenMinAgeMs: 5_000 });

    try {
      const missing = await request(strict.app)
        .post('/links')
        .type('form')
        .send({
          url: 'https://example.com/sin-token',
          [FORM_HONEYPOT_FIELD]: '',
        });

      const tooFast = await request(strict.app)
        .post('/links')
        .type('form')
        .send(formBody({ url: 'https://example.com/demasiado-rapido' }));

      const honeypot = await request(strict.app)
        .post('/links')
        .type('form')
        .send(
          formBody(
            { url: 'https://example.com/honeypot' },
            { ageMs: 6_000, honeypot: 'soy-un-bot' },
          ),
        );

      expect(missing.status).toBe(400);
      expect(tooFast.status).toBe(400);
      expect(honeypot.status).toBe(400);
      expect(honeypot.text).toContain('No se pudo validar el formulario');

      const valid = await request(strict.app)
        .post('/links')
        .type('form')
        .send(
          formBody(
            { url: 'https://example.com/formulario-lento' },
            { ageMs: 6_000 },
          ),
        );

      expect(valid.status).toBe(303);
    } finally {
      await strict.cleanup();
    }
  });

  it('el token del formulario está ligado al HMAC de la IP', async () => {
    const foreignToken = createFormToken(
      FORM_SECRET,
      new Date(),
      'otra-ip-distinta',
    );

    const response = await request(app)
      .post('/links')
      .type('form')
      .send({
        url: 'https://example.com/token-otra-ip',
        [FORM_TOKEN_FIELD]: foreignToken,
        [FORM_HONEYPOT_FIELD]: '',
      });

    expect(response.status).toBe(400);
    expect(response.text).toContain('No se pudo validar el formulario');
  });
});
