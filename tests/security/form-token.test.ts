import { describe, expect, it } from 'vitest';
import {
  createFormToken,
  DEFAULT_FORM_MIN_AGE_MS,
  verifyFormToken,
} from '../../src/security/form-token.js';

const SECRET = 'form-secret-0123456789abcdef';
const NOW = new Date('2026-01-01T12:00:00.000Z');

function tokenAged(ms: number): string {
  return createFormToken(SECRET, new Date(NOW.getTime() - ms));
}

describe('form-token', () => {
  it('acepta un token firmado dentro de la ventana', () => {
    expect(
      verifyFormToken(SECRET, tokenAged(10_000), { now: NOW }),
    ).toBe('valid');
  });

  it('rechaza tokens ausentes o con formato manipulado', () => {
    expect(verifyFormToken(SECRET, undefined, { now: NOW })).toBe('missing');
    expect(verifyFormToken(SECRET, '', { now: NOW })).toBe('missing');
    expect(verifyFormToken(SECRET, 'hola', { now: NOW })).toBe('malformed');
    expect(
      verifyFormToken(SECRET, `${NOW.getTime()}.${'a'.repeat(64)}`, {
        now: NOW,
      }),
    ).toBe('malformed');
  });

  it('rechaza un timestamp alterado aunque conserve la firma', () => {
    const token = tokenAged(10_000);
    const [, signature] = token.split('.');
    const forged = `${NOW.getTime() - 1_000}.${signature}`;

    expect(verifyFormToken(SECRET, forged, { now: NOW })).toBe('malformed');
  });

  it('rechaza un token firmado con otro secreto', () => {
    const token = createFormToken(
      'otro-secreto-0123456789abcdef',
      new Date(NOW.getTime() - 10_000),
    );

    expect(verifyFormToken(SECRET, token, { now: NOW })).toBe('malformed');
  });

  it('rechaza un token firmado para otra IP', () => {
    const token = createFormToken(
      SECRET,
      new Date(NOW.getTime() - 10_000),
      'ip-hash-a',
    );

    expect(
      verifyFormToken(SECRET, token, { now: NOW, context: 'ip-hash-b' }),
    ).toBe('malformed');
    expect(
      verifyFormToken(SECRET, token, { now: NOW, context: 'ip-hash-a' }),
    ).toBe('valid');
  });

  it('rechaza envíos demasiado rápidos, futuros o vencidos', () => {
    expect(
      verifyFormToken(SECRET, tokenAged(500), { now: NOW }),
    ).toBe('too_fast');
    expect(
      verifyFormToken(SECRET, tokenAged(-60_000), { now: NOW }),
    ).toBe('too_fast');
    expect(
      verifyFormToken(SECRET, tokenAged(3 * 60 * 60 * 1000), { now: NOW }),
    ).toBe('expired');
  });

  it('expone el mínimo por defecto del plan', () => {
    expect(DEFAULT_FORM_MIN_AGE_MS).toBeGreaterThan(0);
    expect(
      verifyFormToken(SECRET, tokenAged(DEFAULT_FORM_MIN_AGE_MS + 1), {
        now: NOW,
      }),
    ).toBe('valid');
  });
});
