import { describe, expect, it } from 'vitest';
import { createAliasCache } from './alias-cache.js';
import type { ResolvedLink } from '../links/service.js';

function link(
  alias: string,
  overrides: Partial<ResolvedLink> = {},
): ResolvedLink {
  return {
    alias,
    url: `https://example.com/${alias}`,
    expiresAt: null,
    disabledAt: null,
    ...overrides,
  };
}

describe('createAliasCache', () => {
  it('devuelve el enlace guardado y cuenta hits/misses', () => {
    const cache = createAliasCache();
    const entry = link('abc1234');

    cache.set(entry, new Date('2026-01-01T00:00:00.000Z'));

    expect(cache.get('abc1234', new Date('2026-01-01T00:00:30.000Z'))).toEqual(
      entry,
    );
    expect(cache.get('no-existe')).toBeUndefined();
    expect(cache.stats).toEqual({ hits: 1, misses: 1, evictions: 0 });
  });

  it('expira la entrada al superar el TTL', () => {
    const cache = createAliasCache({ ttlMs: 1_000 });

    cache.set(link('abc1234'), new Date('2026-01-01T00:00:00.000Z'));

    expect(
      cache.get('abc1234', new Date('2026-01-01T00:00:00.999Z')),
    ).toBeDefined();
    expect(
      cache.get('abc1234', new Date('2026-01-01T00:00:01.000Z')),
    ).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('expulsa la entrada menos usada al llenarse (LRU)', () => {
    const cache = createAliasCache({ maxEntries: 2 });
    const at = new Date('2026-01-01T00:00:00.000Z');

    cache.set(link('primero'), at);
    cache.set(link('segundo'), at);

    // Tocar "primero" lo convierte en el más reciente; "segundo" debe salir.
    expect(cache.get('primero', at)).toBeDefined();

    cache.set(link('tercero'), at);

    expect(cache.size).toBe(2);
    expect(cache.get('primero', at)).toBeDefined();
    expect(cache.get('segundo', at)).toBeUndefined();
    expect(cache.get('tercero', at)).toBeDefined();
    expect(cache.stats.evictions).toBe(1);
  });

  it('permite invalidar y limpiar entradas', () => {
    const cache = createAliasCache();
    const at = new Date('2026-01-01T00:00:00.000Z');

    cache.set(link('uno'), at);
    cache.set(link('dos'), at);
    cache.delete('uno');

    expect(cache.get('uno', at)).toBeUndefined();
    expect(cache.get('dos', at)).toBeDefined();

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('descarta una lectura que empezó antes de una invalidación', () => {
    const cache = createAliasCache();
    const at = new Date('2026-01-01T00:00:00.000Z');
    const generation = cache.generation;

    cache.set(link('obsoleto'), at, generation);
    expect(cache.get('obsoleto', at)).toBeDefined();

    cache.delete('obsoleto');
    // La lectura concurrente ya no puede repoblar la entrada.
    cache.set(link('obsoleto'), at, generation);
    expect(cache.get('obsoleto', at)).toBeUndefined();
  });

  it('conserva expiresAt y disabledAt en la entrada', () => {
    const cache = createAliasCache();
    const at = new Date('2026-01-01T00:00:00.000Z');
    const entry = link('expira', {
      expiresAt: '2026-01-01T00:10:00.000Z',
      disabledAt: '2026-01-01T00:05:00.000Z',
    });

    cache.set(entry, at);

    expect(cache.get('expira', at)).toEqual(entry);
  });
});
