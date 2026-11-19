import type { Client } from '@libsql/client';
import type { Express } from 'express';
import type { AppOptions } from '../../src/app.js';
import { createApp, getAppRuntime, type AppRuntime } from '../../src/app.js';
import { config } from '../../src/config.js';
import { createClickBuffer } from '../../src/infra/clicks/click-buffer.js';
import {
  createFormToken,
  FORM_HONEYPOT_FIELD,
  FORM_TOKEN_FIELD,
} from '../../src/security/form-token.js';
import { hashIp } from '../../src/security/ip.js';
import { createTempDatabase, type TempDatabase } from './temp-db.js';

export const ABUSE_EMAIL = 'abuso@example.com';
export const FORM_SECRET = 'test-form-secret-0123456789';
export const UNLIMITED = [
  { name: 'test', limit: 1_000_000, windowMs: 60_000 },
] as const;

// supertest conecta desde loopback; el token del formulario va ligado a ese
// HMAC igual que en producción.
export const TEST_IP_HASH = hashIp(config.ipHashSecret, '127.0.0.1');

export function formToken(ageMs = 0): string {
  return createFormToken(
    FORM_SECRET,
    new Date(Date.now() - ageMs),
    TEST_IP_HASH,
  );
}

export function formBody(
  fields: Record<string, string>,
  options: { ageMs?: number; honeypot?: string } = {},
): Record<string, string> {
  return {
    ...fields,
    [FORM_TOKEN_FIELD]: formToken(options.ageMs ?? 0),
    [FORM_HONEYPOT_FIELD]: options.honeypot ?? '',
  };
}

export type TestApp = {
  app: Express;
  runtime: AppRuntime;
  db: Client;
  database: TempDatabase;
  cleanup: () => Promise<void>;
};

/**
 * App completa con DB temporal y límites holgados.
 *
 * Cada archivo de test crea la suya (o varias) y llama a `cleanup` para cerrar
 * el buffer de clics, el limitador y la base de datos.
 */
export async function createTestApp(
  overrides: AppOptions = {},
): Promise<TestApp> {
  const database = await createTempDatabase();
  const app = createApp({
    db: database.client,
    abuseContactEmail: ABUSE_EMAIL,
    formTokenSecret: FORM_SECRET,
    formTokenMinAgeMs: 0,
    // Los tests no deben chocar con las cuotas de producción; el límite real
    // se prueba aparte con una app dedicada.
    limits: {
      createIp: UNLIMITED,
      createGlobal: [],
      redirectIp: [],
      requestIp: UNLIMITED,
    },
    clickBuffer: createClickBuffer({
      db: database.client,
      intervalMs: 60_000,
    }),
    ...overrides,
  });
  const runtime = getAppRuntime(app);

  return {
    app,
    runtime,
    db: database.client,
    database,
    async cleanup() {
      await runtime.close();
      await database.cleanup();
    },
  };
}
