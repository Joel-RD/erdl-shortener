import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import type { Express } from 'express';
import { config } from '../../src/config.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let context: TestApp;
let app: Express;
let db: Client;

const admin = { Authorization: `Bearer ${config.adminToken}` };

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
  db = context.db;
});

afterAll(async () => {
  await context.cleanup();
});

describe('blocklist y administración', () => {
  it('rechaza un dominio de la blocklist con 422 genérico', async () => {
    const response = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://bit.ly/enlace-encadenado' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(
      expect.objectContaining({ error: 'domain_blocked' }),
    );
    expect(String(response.body.message)).not.toContain('bit.ly');
  });

  it('protege las rutas admin y el takedown invalida la caché', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .send({
        url: 'https://example.com/takedown',
        alias: 'takedown-cache',
      });

    expect(created.status).toBe(201);

    // Calentar la caché de resolución: sin invalidación, este GET seguiría
    // redirigiendo hasta el TTL de 60 s.
    const warm = await request(app).get('/takedown-cache');
    expect(warm.status).toBe(302);

    const noAuth = await request(app).delete(
      '/api/v1/links/takedown-cache',
    );
    const wrongAuth = await request(app)
      .delete('/api/v1/links/takedown-cache')
      .set('Authorization', 'Bearer token-equivocado');

    expect(noAuth.status).toBe(401);
    expect(wrongAuth.status).toBe(401);

    const removed = await request(app)
      .delete('/api/v1/links/takedown-cache')
      .set('Authorization', `Bearer ${config.adminToken}`);

    expect(removed.status).toBe(204);

    const afterTakedown = await request(app).get('/takedown-cache');
    const metadata = await request(app).get(
      '/api/v1/links/takedown-cache',
    );

    expect(afterTakedown.status).toBe(410);
    expect(afterTakedown.body).toEqual({ error: 'gone' });
    expect(metadata.status).toBe(410);

    // Idempotente: repetir el takedown no borra la fila ni da 404.
    const again = await request(app)
      .delete('/api/v1/links/takedown-cache')
      .set('Authorization', `Bearer ${config.adminToken}`);
    const missing = await request(app)
      .delete('/api/v1/links/no-existe-admin')
      .set('Authorization', `Bearer ${config.adminToken}`);

    expect(again.status).toBe(204);
    expect(missing.status).toBe(404);
  });

  it('añade y desactiva dominios de la blocklist en caliente', async () => {
    const noAuth = await request(app)
      .post('/api/v1/admin/blocklist')
      .send({ domain: 'bloqueo-admin.test' });
    const invalid = await request(app)
      .post('/api/v1/admin/blocklist')
      .set('Authorization', `Bearer ${config.adminToken}`)
      .send({ domain: 'localhost' });

    expect(noAuth.status).toBe(401);
    expect(invalid.status).toBe(400);

    const added = await request(app)
      .post('/api/v1/admin/blocklist')
      .set('Authorization', `Bearer ${config.adminToken}`)
      .send({ domain: 'https://sub.bloqueo-admin.test/ruta' });

    expect(added.status).toBe(201);
    expect(added.body).toEqual({
      domain: 'bloqueo-admin.test',
      source: 'manual',
      enabled: true,
      disabledLinks: 0,
    });

    const blocked = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://otro.bloqueo-admin.test/destino' });

    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('domain_blocked');

    const disabled = await request(app)
      .post('/api/v1/admin/blocklist')
      .set('Authorization', `Bearer ${config.adminToken}`)
      .send({ domain: 'bloqueo-admin.test', enabled: false });

    expect(disabled.status).toBe(201);
    expect(disabled.body.enabled).toBe(false);

    const allowed = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://tercero.bloqueo-admin.test/destino' });

    expect(allowed.status).toBe(201);
  });

  it('bloquear un dominio deshabilita los enlaces ya creados hacia él', async () => {
    const existing = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://phishing.retirar-existentes.test/login' });
    const sibling = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://sub.retirar-existentes.test/otro' });
    const unrelated = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://noretirar-existentes.test/ok' });

    // Calienta la caché: sin invalidación seguiría redirigiendo hasta el TTL.
    const warm = await request(app).get(`/${existing.body.alias}`);
    expect(warm.status).toBe(302);

    const blocked = await request(app)
      .post('/api/v1/admin/blocklist')
      .set(admin)
      .send({ domain: 'retirar-existentes.test' });

    expect(blocked.status).toBe(201);
    expect(blocked.body.disabledLinks).toBe(2);

    expect((await request(app).get(`/${existing.body.alias}`)).status).toBe(
      410,
    );
    expect((await request(app).get(`/${sibling.body.alias}`)).status).toBe(
      410,
    );
    expect(
      (await request(app).get(`/api/v1/links/${existing.body.alias}`)).status,
    ).toBe(410);
    // Un dominio parecido pero distinto no se toca.
    expect((await request(app).get(`/${unrelated.body.alias}`)).status).toBe(
      302,
    );

    const reason = await db.execute({
      sql: 'SELECT disabled_reason FROM links WHERE alias = ?',
      args: [existing.body.alias],
    });
    expect(reason.rows[0]?.disabled_reason).toBe('domain_blocked');

    // Idempotente: repetir el alta no vuelve a tocar nada.
    const again = await request(app)
      .post('/api/v1/admin/blocklist')
      .set(admin)
      .send({ domain: 'retirar-existentes.test' });
    expect(again.body.disabledLinks).toBe(0);
  });

  it('desactivar una entrada de la blocklist no reactiva enlaces retirados', async () => {
    const created = await request(app)
      .post('/api/v1/links')
      .send({ url: 'https://sin-reactivar.test/x' });

    await request(app)
      .post('/api/v1/admin/blocklist')
      .set(admin)
      .send({ domain: 'sin-reactivar.test' });

    const off = await request(app)
      .post('/api/v1/admin/blocklist')
      .set(admin)
      .send({ domain: 'sin-reactivar.test', enabled: false });

    expect(off.body.disabledLinks).toBe(0);
    expect((await request(app).get(`/${created.body.alias}`)).status).toBe(
      410,
    );
  });
});
