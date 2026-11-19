import { describe, expect, it } from 'vitest';
import {
  consumeRules,
  createMemoryRateLimiter,
  type RateLimitRule,
} from '../../src/security/rate-limit.js';

const MINUTE: RateLimitRule = { name: 'minute', limit: 2, windowMs: 60_000 };

describe('createMemoryRateLimiter', () => {
  it('permite hasta el límite y rechaza con Retry-After', () => {
    const limiter = createMemoryRateLimiter({ cleanupIntervalMs: 0 });
    const now = Date.parse('2026-01-01T00:00:00.000Z');

    expect(limiter.consume('ip', MINUTE, now)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume('ip', MINUTE, now)).toEqual({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume('ip', MINUTE, now + 40_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 20,
    });
  });

  it('reinicia la ventana al pasar el tiempo', () => {
    const limiter = createMemoryRateLimiter({ cleanupIntervalMs: 0 });
    const now = Date.parse('2026-01-01T00:00:00.000Z');

    limiter.consume('ip', MINUTE, now);
    limiter.consume('ip', MINUTE, now);

    expect(limiter.consume('ip', MINUTE, now + 60_000)).toEqual({
      allowed: true,
      remaining: 1,
    });
  });

  it('mantiene claves independientes por IP', () => {
    const limiter = createMemoryRateLimiter({ cleanupIntervalMs: 0 });
    const now = Date.parse('2026-01-01T00:00:00.000Z');

    limiter.consume('ip-a', MINUTE, now);
    limiter.consume('ip-a', MINUTE, now);

    expect(limiter.consume('ip-a', MINUTE, now).allowed).toBe(false);
    expect(limiter.consume('ip-b', MINUTE, now).allowed).toBe(true);
  });

  it('respeta el tope de entradas y limpia ventanas vencidas', () => {
    const limiter = createMemoryRateLimiter({
      maxEntries: 2,
      cleanupIntervalMs: 0,
    });
    const now = Date.parse('2026-01-01T00:00:00.000Z');

    limiter.consume('a', MINUTE, now);
    limiter.consume('b', MINUTE, now);
    limiter.consume('c', MINUTE, now);

    expect(limiter.size).toBe(2);

    limiter.cleanup(now + 60_000);
    expect(limiter.size).toBe(0);
  });

  it('aplica varias reglas y devuelve la primera rechazada', () => {
    const limiter = createMemoryRateLimiter({ cleanupIntervalMs: 0 });
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const rules: RateLimitRule[] = [
      { name: 'minute', limit: 5, windowMs: 60_000 },
      { name: 'hour', limit: 2, windowMs: 3_600_000 },
    ];

    expect(consumeRules(limiter, 'create:ip:x', rules, now)).toBeNull();
    expect(consumeRules(limiter, 'create:ip:x', rules, now)).toBeNull();

    expect(consumeRules(limiter, 'create:ip:x', rules, now)).toEqual({
      rule: 'hour',
      retryAfterSeconds: 3_600,
    });
  });

  it('close() detiene el timer de limpieza', () => {
    const limiter = createMemoryRateLimiter({ cleanupIntervalMs: 60_000 });

    expect(() => limiter.close()).not.toThrow();
    expect(() => limiter.close()).not.toThrow();
  });
});
