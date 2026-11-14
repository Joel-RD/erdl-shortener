import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { Client } from '@libsql/client';
import { getDomain } from 'tldts';
import { z } from 'zod';

/**
 * Blocklist de dominios.
 *
 * Une dos fuentes:
 * - `seed/blocklist.json`: acortadores y redirectores conocidos, versionados
 *   con el código. Nunca requiere una escritura en la DB.
 * - `blocked_domains`: altas manuales del endpoint admin, editables en caliente.
 *
 * Se consulta en cada creación, así que el conjunto completo (semilla + DB) se
 * cachea 60 s. El alta manual invalida la caché para que el takedown se note de
 * inmediato, sin esperar el TTL.
 *
 * La comparación es por dominio registrable: bloquear `example.co.uk` bloquea
 * también `a.b.example.co.uk`, pero no `notexample.co.uk`.
 */

export const DEFAULT_BLOCKLIST_CACHE_TTL_MS = 60_000;

const seedSchema = z.object({
  domains: z.array(z.string().trim().min(1)),
});

function loadSeedDomains(): string[] {
  // `src/abuse/` en desarrollo y `dist/abuse/` tras el build: en ambos casos
  // `../../seed/` cae en la raíz del proyecto. No depende de compilar JSON.
  const raw = readFileSync(
    new URL('../../seed/blocklist.json', import.meta.url),
    'utf8',
  );

  return seedSchema.parse(JSON.parse(raw)).domains;
}

/**
 * Convierte una entrada escrita por una persona en un dominio registrable en
 * ASCII y minúsculas. Acepta un dominio suelto o una URL completa.
 *
 * Devuelve `null` para IPs (la validación de URL ya las controla) y para
 * entradas sin dominio público reconocible.
 */
export function normalizeBlocklistDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();

  if (value === '') return null;

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }

  value = value
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  // Acepta también `ejemplo.com/ruta` y `ejemplo.com:8080` sin exigir esquema.
  value = (value.split('/')[0] ?? '').replace(/:\d+$/, '').replace(/^.*@/, '');

  if (value === '' || value.length > 253) return null;

  const host = value.replace(/^\[|\]$/g, '');

  // Las IP no tienen dominio registrable; el validador de URLs ya rechaza las
  // privadas y aquí no queremos bloquear rangos públicos enteros por accidente.
  if (isIP(host)) return null;

  const ascii = domainToASCII(host);

  if (ascii === '' || !ascii.includes('.')) return null;

  return (getDomain(ascii, { allowPrivateDomains: false }) ?? ascii).toLowerCase();
}

/**
 * Comprueba si un dominio coincide con alguna entrada. Recorre los sufijos
 * para que `sub.example.com` quede cubierto por `example.com`.
 */
export function matchesBlockedDomain(
  domain: string,
  blockedDomains: ReadonlySet<string>,
): boolean {
  const normalized = normalizeBlocklistDomain(domain);

  if (normalized === null) return false;

  const labels = normalized.split('.');

  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');

    if (blockedDomains.has(candidate)) return true;
  }

  return false;
}

export type BlocklistOptions = {
  db: Client;
  /** Dominio del propio acortador, bloqueado siempre para evitar bucles. */
  ownDomain?: string | undefined;
  now?: (() => Date) | undefined;
  cacheTtlMs?: number | undefined;
};

export type BlocklistAddResult = {
  domain: string;
  enabled: boolean;
};

export type Blocklist = {
  isBlocked(domain: string): Promise<boolean>;
  /** Alta o actualización manual; invalida la caché al terminar. */
  addManual(domain: string, enabled?: boolean): Promise<BlocklistAddResult>;
  invalidate(): void;
};

export function createBlocklist({
  db,
  ownDomain,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_BLOCKLIST_CACHE_TTL_MS,
}: BlocklistOptions): Blocklist {
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

    if (inFlight !== null) return inFlight;

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

    async addManual(domain, enabled = true) {
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
