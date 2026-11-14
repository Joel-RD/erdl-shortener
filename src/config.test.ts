import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

const validEnv = {
  BASE_URL: 'https://short.test/',
  ADMIN_TOKEN: '0123456789abcdef',
};

describe('parseConfig', () => {
  it('aplica defaults y normaliza BASE_URL a su origen', () => {
    const parsed = parseConfig(validEnv);

    expect(parsed.baseUrl).toBe('https://short.test');
    expect(parsed.port).toBe(3000);
    expect(parsed.trustProxy).toBe(0);
    expect(parsed.logLevel).toBe('info');
    expect(parsed.databaseUrl).toBe('file:local.db');
    expect(parsed.databaseAuthToken).toBeUndefined();
  });

  it('normaliza DATABASE_AUTH_TOKEN vacío a undefined', () => {
    const parsed = parseConfig({ ...validEnv, DATABASE_AUTH_TOKEN: '  ' });

    expect(parsed.databaseAuthToken).toBeUndefined();
  });

  it('acepta y normaliza el correo de abuso; vacío significa desactivado', () => {
    const configured = parseConfig({
      ...validEnv,
      ABUSE_CONTACT_EMAIL: ' abuso@example.com ',
    });
    const disabled = parseConfig({ ...validEnv, ABUSE_CONTACT_EMAIL: '  ' });

    expect(configured.abuseContactEmail).toBe('abuso@example.com');
    expect(disabled.abuseContactEmail).toBeUndefined();
  });

  it('rechaza un correo de abuso inválido', () => {
    expect(() =>
      parseConfig({ ...validEnv, ABUSE_CONTACT_EMAIL: 'no-es-un-correo' }),
    ).toThrow(/ABUSE_CONTACT_EMAIL/);
  });

  it('rechaza DATABASE_URL con un protocolo no soportado', () => {
    expect(() =>
      parseConfig({ ...validEnv, DATABASE_URL: 'postgres://localhost/erdl' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('falla si ADMIN_TOKEN no está definido', () => {
    expect(() => parseConfig({ BASE_URL: validEnv.BASE_URL })).toThrow(
      /ADMIN_TOKEN/,
    );
  });

  it('rechaza BASE_URL con un protocolo distinto de http/https', () => {
    expect(() =>
      parseConfig({ ...validEnv, BASE_URL: 'ftp://short.test' }),
    ).toThrow(/BASE_URL/);
  });
});
