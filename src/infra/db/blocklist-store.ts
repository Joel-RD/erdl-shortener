import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { z } from 'zod';
import {
  matchesBlockedDomain,
  normalizeBlocklistDomain,
  type Blocklist,
  type BlocklistAddResult,
} from '../../domain/abuse/blocklist.js';

/**
 * Blocklist respaldada por la semilla versionada y la tabla `blocked_domains`.
 *
 * - `seed/blocklist.json`: acortadores y redirectores conocidos, versionados
 *   con el código. Nunca requiere una escritura en la DB.
 * - `blocked_domains`: altas manuales del endpoint admin, editables en caliente.
 *
 * Se consulta en cada creación, así que el conjunto completo (semilla + DB) se
 * cachea 60 s. El alta manual invalida la caché para que el takedown se note de
 * inmediato, sin esperar el TTL.
 */

export const DEFAULT_BLOCKLIST_CACHE_TTL_MS = 60_000;

const seedSchema = z.object({
  domains: z.array(z.string().trim().min(1)),
});

function loadSeedDomains(): string[] {
  // `src/infra/db/` en desarrollo y `dist/infra/db/` tras el build: en ambos
  // casos `../../../seed/` cae en la raíz del proyecto. No depende de
  // compilar JSON.
  const raw = readFileSync(
    new URL('../../../seed/blocklist.json', import.meta.url),
    'utf8',
  );

  return seedSchema.parse(JSON.parse(raw)).domains;
}

export type BlocklistStoreOptions = {
  db: Client;
  /** Dominio del propio acortador, bloqueado siempre para evitar bucles. */
  ownDomain?: string | undefined;
  now?: (() => Date) | undefined;
  cacheTtlMs?: number | undefined;
};

export function createBlocklistStore({
  db,
  ownDomain,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_BLOCKLIST_CACHE_TTL_MS,
}: BlocklistStoreOptions): Blocklist {
  const own = ownDomain ? normalizeBlocklistDomain(ownDomain) : null;
  const seedDomains = new Set(
    loadSeedDomains()
      .map((domain) => normalizeBlocklistDomain(domain))
      .filter((domain): domain is string => domain !== null),
  );

  if (own !== null) seedDomains.add(own);

  let cached: Set<string> | null = null;
  let loadedAtMs = 0;
  let generation = 0;
  let inFlight: Promise<Set<string>> | null = null;

  function invalidate(): void {
    generation += 1;
    cached = null;
    loadedAtMs = 0;
  }

  async function load(currentMs: number): Promise<Set<string>> {
    if (cached !== null && currentMs - loadedAtMs < cacheTtlMs) {
      return cached;
    }

    if (inFlight !== null) {
      // Si el alta manual invalidó la caché mientras la consulta estaba en
      // vuelo, la promesa compartida trae datos viejos. Esperar y volver a
      // evaluar evita devolver una blocklist obsoleta al llamante.
      await inFlight;

      if (cached !== null && currentMs - loadedAtMs < cacheTtlMs) {
        return cached;
      }

      return load(currentMs);
    }

    const startedGeneration = generation;

    inFlight = (async () => {
      const result = await db.execute(
        'SELECT domain, enabled FROM blocked_domains',
      );
      const domains = new Set(seedDomains);

      for (const row of result.rows) {
        const normalized = normalizeBlocklistDomain(String(row.domain));

        if (normalized === null) continue;

        if (Number(row.enabled) === 1) {
          domains.add(normalized);
        } else {
          // Una fila desactivada también puede apagar una entrada de la
          // semilla (por ejemplo, retirar temporalmente bit.ly).
          domains.delete(normalized);
        }
      }

      // Si un alta manual invalidó la caché mientras esta consulta estaba en
      // vuelo, no la guardamos: el siguiente hit debe ver el dato nuevo.
      if (startedGeneration === generation) {
        cached = domains;
        loadedAtMs = currentMs;
      }

      return domains;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return {
    async isBlocked(domain) {
      const normalized = normalizeBlocklistDomain(domain);

      if (normalized === null) return false;

      const blockedDomains = await load(now().getTime());

      return matchesBlockedDomain(normalized, blockedDomains);
    },

    async addManual(domain, enabled = true): Promise<BlocklistAddResult> {
      const normalized = normalizeBlocklistDomain(domain);

      if (normalized === null) {
        throw new Error(`Dominio no válido: ${domain}`);
      }

      await db.execute({
        sql: `INSERT INTO blocked_domains (domain, source, enabled)
              VALUES (?, 'manual', ?)
              ON CONFLICT(domain) DO UPDATE SET
                source = 'manual',
                enabled = excluded.enabled`,
        args: [normalized, enabled ? 1 : 0],
      });

      invalidate();

      return { domain: normalized, enabled };
    },

    invalidate,
  };
}
