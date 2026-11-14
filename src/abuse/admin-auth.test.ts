import { describe, expect, it } from 'vitest';
import { readBearerToken, verifyAdminToken } from './admin-auth.js';

describe('verifyAdminToken', () => {
  it('acepta el token correcto y rechaza cualquier otro', () => {
    expect(verifyAdminToken('token-secreto', 'token-secreto')).toBe(true);
    expect(verifyAdminToken('token-secreto', 'token-secret0')).toBe(false);
    expect(verifyAdminToken('token-secreto', '')).toBe(false);
    expect(verifyAdminToken('token-secreto', 'x'.repeat(10_000))).toBe(false);
  });
});

describe('readBearerToken', () => {
  it('lee el esquema Bearer sin distinguir mayúsculas', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('bearer   abc  ')).toBe('abc');
  });

  it('rechaza cabeceras ausentes o con otro esquema', () => {
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken('')).toBeNull();
    expect(readBearerToken('Basic abc')).toBeNull();
    expect(readBearerToken('Bearer   ')).toBeNull();
  });
});
