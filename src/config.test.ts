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
