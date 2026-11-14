import type { ResolvedLink } from '../links/service.js';

/**
 * Caché LRU en memoria para el redirect.
 *
 * Guarda el destino **y** el estado relevante (`expiresAt`, `disabledAt`): si
 * solo guardáramos la URL, un enlace vencido seguiría redirigiendo hasta que
 * expirara la entrada. La caché solo almacena enlaces activos; los 404 nunca
 * se cachean para que un alias recién creado no parezca inexistente.
 *
 * El TTL es corto (60 s por defecto) porque un takedown debe notarse pronto.
 * Además, la Fase 7 invalida la entrada explícitamente al deshabilitar.
 */

export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

export type AliasCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
};

export type AliasCacheStats = {
  hits: number;
  misses: number;
  evictions: number;
};

export type AliasCache = {
  get(alias: string, at?: Date): ResolvedLink | undefined;
  set(link: ResolvedLink, at?: Date): void;
  delete(alias: string): void;
  clear(): void;
  readonly size: number;
  readonly stats: Readonly<AliasCacheStats>;
};

type CacheEntry = {
  link: ResolvedLink;
  storedAtMs: number;
};

export function createAliasCache(options: AliasCacheOptions = {}): AliasCache {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => new Date());

  const entries = new Map<string, CacheEntry>();
  const stats: AliasCacheStats = { hits: 0, misses: 0, evictions: 0 };

  function evictIfNeeded(): void {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next();

      if (oldestKey.done) return;

      entries.delete(oldestKey.value);
      stats.evictions += 1;
    }
  }

  return {
    get(alias, at) {
      const entry = entries.get(alias);

      if (!entry) {
        stats.misses += 1;
        return undefined;
      }

      const atMs = (at ?? now()).getTime();

      if (atMs - entry.storedAtMs >= ttlMs) {
        entries.delete(alias);
        stats.misses += 1;
        return undefined;
      }

      // Map conserva orden de inserción: borrar y reinsertar convierte la
      // entrada en la más reciente para la evicción LRU.
      entries.delete(alias);
      entries.set(alias, entry);
      stats.hits += 1;

      return entry.link;
    },

    set(link, at) {
      const storedAtMs = (at ?? now()).getTime();

      entries.delete(link.alias);
      entries.set(link.alias, { link, storedAtMs });
      evictIfNeeded();
    },

    delete(alias) {
      entries.delete(alias);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },

    get stats() {
      return { ...stats };
    },
  };
}
