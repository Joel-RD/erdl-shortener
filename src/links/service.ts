import { createHash } from 'node:crypto';
import type {
  Client,
  InStatement,
  ResultSet,
  Row,
} from '@libsql/client';
import type { AliasCache } from '../cache/alias-cache.js';
import type { ClickBuffer } from '../abuse/click-buffer.js';
import type { Blocklist } from '../abuse/blocklist.js';
import {
  generateAlias,
  validateCustomAlias,
  type AliasErrorCode,
} from './alias.js';
import {
  validateUrl,
  type UrlErrorCode,
} from './validate.js';

/**
 * Reglas de negocio de los enlaces.
 *
 * Las rutas no deciden nada: llaman aquí y traducen el resultado a HTTP. El
 * servicio orquesta validación, dedupe, cuota, generación/validación de alias,
 * persistencia, caché de resolución y buffer de clics.
 */

const GENERATED_ALIAS_ATTEMPTS = 5;
const MIN_EXPIRATION_MS = 5 * 60 * 1000;
const MAX_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ACTIVE_LINKS_PER_IP = 50;

const SELECT_COLUMNS = `
  alias, url, url_hash, domain, created_ip_hash, created_at, expires_at,
  clicks, last_clicked_at, disabled_at, disabled_reason
`;

export type LinkRecord = {
  alias: string;
  url: string;
  urlHash: string;
  domain: string;
  createdIpHash: string | null;
  createdAt: string;
  expiresAt: string | null;
  clicks: number;
  lastClickedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
};

/** Lo mínimo que necesita el redirect y lo que se guarda en caché. */
export type ResolvedLink = Pick<
  LinkRecord,
  'alias' | 'url' | 'expiresAt' | 'disabledAt'
>;

/** Datos que pueden mostrarse sin autenticación. */
export type PublicLink = {
  alias: string;
  url: string;
  clicks: number;
  createdAt: string;
  expiresAt: string | null;
  lastClickedAt: string | null;
};

export type CreateLinkInput = {
  url: string;
  alias?: string | undefined;
  expiresAt?: Date | null | undefined;
  /** HMAC de la IP; sin él no hay dedupe ni cuota (tests/dev). */
  createdIpHash?: string | null | undefined;
};

export type CreateLinkErrorCode =
  | UrlErrorCode
  | AliasErrorCode
  | 'alias_taken'
  | 'domain_blocked'
  | 'expiration_invalid'
  | 'quota_exceeded';

export type CreateLinkResult =
  | { ok: true; link: LinkRecord }
  | {
      ok: false;
      code: CreateLinkErrorCode;
      message: string;
      /** Solo para `quota_exceeded`: estimación de cuándo se libera cupo. */
      retryAfterSeconds?: number;
    };

export type ResolveResult =
  | { ok: true; link: ResolvedLink }
  | { ok: false; reason: 'not_found' | 'gone' };

export type LookupResult =
  | { ok: true; link: LinkRecord }
  | { ok: false; reason: 'not_found' | 'gone' };

export type DisableResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

export type LinkService = {
  create(input: CreateLinkInput): Promise<CreateLinkResult>;
  /**
   * `recordClick: false` se usa en HEAD: devuelve la metadata de redirect sin
   * contar una visita.
   */
  resolve(
    alias: string,
    options?: { recordClick?: boolean },
  ): Promise<ResolveResult>;
  getMetadata(alias: string): Promise<LookupResult>;
  /** Takedown: marca la fila y invalida la caché sin borrar el alias. */
  disable(alias: string, reason?: string): Promise<DisableResult>;
  /**
   * Takedown masivo: deshabilita todos los enlaces activos de un dominio
   * registrable (el que se guarda en `links.domain`). Devuelve cuántos
   * enlaces cambió. Es idempotente: repetirlo devuelve 0.
   */
  disableByDomain(domain: string, reason?: string): Promise<number>;
  /** Invalida la caché de un alias (lo usa el takedown de la Fase 7). */
  invalidate(alias: string): void;
};

export type LinkServiceOptions = {
  db: Client;
  now?: (() => Date) | undefined;
  cache?: AliasCache | undefined;
  clickBuffer?: Pick<ClickBuffer, 'record'> | undefined;
  blocklist?: Pick<Blocklist, 'isBlocked'> | undefined;
  dedupeWindowMs?: number | undefined;
  maxActiveLinksPerIp?: number | undefined;
};

/** Lo que comparten `Client` y `Transaction` para ejecutar sentencias. */
type SqlExecutor = {
  execute(statement: InStatement): Promise<ResultSet>;
};

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toLinkRecord(row: Row): LinkRecord {
  return {
    alias: String(row.alias),
    url: String(row.url),
    urlHash: String(row.url_hash),
    domain: String(row.domain),
    createdIpHash: nullableString(row.created_ip_hash),
    createdAt: String(row.created_at),
    expiresAt: nullableString(row.expires_at),
    clicks: Number(row.clicks),
    lastClickedAt: nullableString(row.last_clicked_at),
    disabledAt: nullableString(row.disabled_at),
    disabledReason: nullableString(row.disabled_reason),
  };
}

function toResolvedLink(link: LinkRecord): ResolvedLink {
  return {
    alias: link.alias,
    url: link.url,
    expiresAt: link.expiresAt,
    disabledAt: link.disabledAt,
  };
}

export function toPublicLink(link: LinkRecord): PublicLink {
  return {
    alias: link.alias,
    url: link.url,
    clicks: link.clicks,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    lastClickedAt: link.lastClickedAt,
  };
}

function isGone(
  link: Pick<ResolvedLink, 'disabledAt' | 'expiresAt'>,
  now: Date,
): boolean {
  if (link.disabledAt !== null) return true;

  if (link.expiresAt !== null) {
    const expiry = Date.parse(link.expiresAt);
    return Number.isFinite(expiry) && expiry <= now.getTime();
  }

  return false;
}

export function createLinkService({
  db,
  now = () => new Date(),
  cache,
  clickBuffer,
  blocklist,
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
  maxActiveLinksPerIp = DEFAULT_MAX_ACTIVE_LINKS_PER_IP,
}: LinkServiceOptions): LinkService {
  async function findByAlias(
    alias: string,
    executor: SqlExecutor = db,
  ): Promise<LinkRecord | null> {
    const result = await executor.execute({
      sql: `SELECT ${SELECT_COLUMNS} FROM links WHERE alias = ? LIMIT 1`,
      args: [alias],
    });

    const row = result.rows[0];
    return row ? toLinkRecord(row) : null;
  }

  async function findRecentDuplicate(
    urlHash: string,
    createdIpHash: string,
    expiresAt: string | null,
    current: Date,
    executor: SqlExecutor = db,
  ): Promise<LinkRecord | null> {
    const since = new Date(
      current.getTime() - dedupeWindowMs,
    ).toISOString();

    const result = await executor.execute({
      sql: `SELECT ${SELECT_COLUMNS}
              FROM links
             WHERE url_hash = ?
               AND created_ip_hash = ?
               AND created_at >= ?
               AND disabled_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?)
               AND expires_at IS ?
             ORDER BY created_at DESC
             LIMIT 1`,
      // `IS ?` compara igual que `=` pero también casa NULL con NULL: un
      // enlace permanente solo es duplicado de otra petición permanente, y
      // uno con caducidad solo de otra con exactamente la misma caducidad.
      // Así nunca se devuelve un enlace con una vida distinta a la pedida.
      args: [urlHash, createdIpHash, since, current.toISOString(), expiresAt],
    });

    const row = result.rows[0];
    return row ? toLinkRecord(row) : null;
  }

  async function countActiveLinks(
    createdIpHash: string,
    current: Date,
    executor: SqlExecutor = db,
  ): Promise<{ total: number; nextExpiresAt: string | null }> {
    const result = await executor.execute({
      sql: `SELECT COUNT(*) AS total,
                   MIN(CASE WHEN expires_at IS NOT NULL THEN expires_at END)
                     AS next_expires_at
              FROM links
             WHERE created_ip_hash = ?
               AND disabled_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?)`,
      args: [createdIpHash, current.toISOString()],
    });

    const row = result.rows[0];

    return {
      total: Number(row?.total ?? 0),
      nextExpiresAt: nullableString(row?.next_expires_at),
    };
  }

  function validateExpiration(
    expiresAt: Date | null | undefined,
    current: Date,
  ): { ok: true; value: string | null } | { ok: false; message: string } {
    if (expiresAt === null || expiresAt === undefined) {
      return { ok: true, value: null };
    }

    const timestamp = expiresAt.getTime();

    if (!Number.isFinite(timestamp)) {
      return { ok: false, message: 'La fecha de expiración no es válida.' };
    }

    const currentMs = current.getTime();

    if (timestamp < currentMs + MIN_EXPIRATION_MS) {
      return {
        ok: false,
        message: 'La expiración debe ser al menos 5 minutos posterior a ahora.',
      };
    }

    if (timestamp > currentMs + MAX_EXPIRATION_MS) {
      return {
        ok: false,
        message: 'La expiración no puede superar un año desde ahora.',
      };
    }

    return { ok: true, value: expiresAt.toISOString() };
  }

  return {
    async create(input) {
      const validated = validateUrl(input.url);

      if (!validated.ok) {
        return {
          ok: false,
          code: validated.code,
          message: validated.message,
        };
      }

      // La blocklist se consulta con el dominio registrable ya normalizado,
      // así que un subdominio nuevo del mismo dominio también queda cubierto.
      if (blocklist && (await blocklist.isBlocked(validated.value.domain))) {
        return {
          ok: false,
          code: 'domain_blocked',
          // Mensaje genérico a propósito: no revelamos qué lista ni qué
          // entrada concreta bloqueó la URL.
          message: 'Ese dominio no está permitido en este servicio.',
        };
      }

      const current = now();
      const expiration = validateExpiration(input.expiresAt, current);

      if (!expiration.ok) {
        return {
          ok: false,
          code: 'expiration_invalid',
          message: expiration.message,
        };
      }

      const customAlias = input.alias?.trim();
      const wantsCustomAlias =
        customAlias !== undefined && customAlias !== '';
      let validatedCustomAlias: string | null = null;

      if (wantsCustomAlias) {
        const validatedAlias = validateCustomAlias(customAlias);

        if (!validatedAlias.ok) {
          return {
            ok: false,
            code: validatedAlias.code,
            message: validatedAlias.message,
          };
        }

        validatedCustomAlias = validatedAlias.alias;
      }

      const urlHash = hashUrl(validated.value.url);
      const createdIpHash = input.createdIpHash ?? null;
      const transaction = await db.transaction('write');

      try {
        if (createdIpHash !== null) {
          // Dedupe solo para alias generados: si la persona pidió un alias
          // concreto, ese alias manda y la colisión se resuelve aparte.
          if (!wantsCustomAlias) {
            const duplicate = await findRecentDuplicate(
              urlHash,
              createdIpHash,
              expiration.value,
              current,
              transaction,
            );

            if (duplicate) {
              await transaction.commit();
              return { ok: true, link: duplicate };
            }
          }

          const activeLinks = await countActiveLinks(
            createdIpHash,
            current,
            transaction,
          );

          if (activeLinks.total >= maxActiveLinksPerIp) {
            // Sin caducidades pendientes no hay un momento exacto de
            // liberación; 1 h es una estimación conservadora.
            const nextExpiryMs = activeLinks.nextExpiresAt
              ? Date.parse(activeLinks.nextExpiresAt)
              : Number.NaN;
            const retryAfterSeconds = Number.isFinite(nextExpiryMs)
              ? Math.max(
                  1,
                  Math.min(
                    86_400,
                    Math.ceil((nextExpiryMs - current.getTime()) / 1000),
                  ),
                )
              : 3_600;

            await transaction.commit();
            return {
              ok: false,
              code: 'quota_exceeded',
              message:
                'Has alcanzado el límite de enlaces activos para tu IP. Espera a que caduquen algunos.',
              retryAfterSeconds,
            };
          }
        }

        let alias = validatedCustomAlias ?? generateAlias();
        const attempts = validatedCustomAlias ? 1 : GENERATED_ALIAS_ATTEMPTS;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            await transaction.execute({
              sql: `INSERT INTO links
                      (alias, url, url_hash, domain, created_ip_hash,
                       created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
              args: [
                alias,
                validated.value.url,
                urlHash,
                validated.value.domain,
                createdIpHash,
                current.toISOString(),
                expiration.value,
              ],
            });
          } catch (error) {
            // No dependemos del texto del error: si la fila ya existe, es una
            // colisión de alias; si no, es un fallo real que debe propagarse.
            const existing = await findByAlias(alias, transaction);

            if (!existing) throw error;

            if (validatedCustomAlias) {
              await transaction.commit();
              return {
                ok: false,
                code: 'alias_taken',
                message: 'Ese alias ya está en uso. Prueba con otro.',
              };
            }

            alias = generateAlias();
            continue;
          }

          const link = await findByAlias(alias, transaction);

          if (!link) {
            throw new Error(
              `El enlace ${alias} se insertó pero no se pudo leer`,
            );
          }

          // Dedupe, cuota y escritura comparten transacción: dos peticiones
          // simultáneas de la misma IP no pueden saltarse el cupo.
          await transaction.commit();
          return { ok: true, link };
        }

        throw new Error(
          `No se pudo generar un alias libre tras ${GENERATED_ALIAS_ATTEMPTS} intentos`,
        );
      } catch (error) {
        try {
          await transaction.rollback();
        } catch {
          // La transacción pudo cerrarse ya al fallar la sentencia.
        }

        throw error;
      } finally {
        transaction.close();
      }
    },

    async resolve(alias, options) {
      const recordClick = options?.recordClick !== false;
      const current = now();
      const cached = cache?.get(alias, current);

      if (cached) {
        if (isGone(cached, current)) {
          cache?.delete(alias);
          return { ok: false, reason: 'gone' };
        }

        if (recordClick) clickBuffer?.record(alias, current);
        return { ok: true, link: cached };
      }

      // Generación antes de la lectura: si un takedown invalida la caché
      // mientras la DB responde, set() descarta esta entrada obsoleta.
      const generation = cache?.generation;
      const link = await findByAlias(alias);

      if (!link) return { ok: false, reason: 'not_found' };
      if (isGone(link, current)) return { ok: false, reason: 'gone' };

      const resolved = toResolvedLink(link);
      cache?.set(resolved, current, generation);
      if (recordClick) clickBuffer?.record(alias, current);

      return { ok: true, link: resolved };
    },

    async getMetadata(alias) {
      const link = await findByAlias(alias);

      if (!link) return { ok: false, reason: 'not_found' };
      if (isGone(link, now())) return { ok: false, reason: 'gone' };

      return { ok: true, link };
    },

    async disable(alias, reason = 'admin_takedown') {
      const result = await db.execute({
        sql: `UPDATE links
                 SET disabled_at = ?, disabled_reason = ?
               WHERE alias = ?
                 AND disabled_at IS NULL`,
        args: [now().toISOString(), reason, alias],
      });

      // Invalidar siempre es barato y evita que una entrada caliente siga
      // redirigiendo si el UPDATE no cambió nada (por ejemplo, un takedown
      // repetido sobre un enlace ya deshabilitado).
      cache?.delete(alias);

      if (result.rowsAffected > 0) return { ok: true };

      const existing = await findByAlias(alias);

      return existing ? { ok: true } : { ok: false, reason: 'not_found' };
    },

    async disableByDomain(domain, reason = 'domain_blocked') {
      const result = await db.execute({
        sql: `UPDATE links
                 SET disabled_at = ?, disabled_reason = ?
               WHERE domain = ?
                 AND disabled_at IS NULL`,
        args: [now().toISOString(), reason, domain.toLowerCase()],
      });

      // La caché no indexa por dominio y su TTL es de 60 s: vaciarla es la
      // forma barata de que ningún enlace retirado siga redirigiendo.
      if (result.rowsAffected > 0) cache?.clear();

      return result.rowsAffected;
    },

    invalidate(alias) {
      cache?.delete(alias);
    },
  };
}
