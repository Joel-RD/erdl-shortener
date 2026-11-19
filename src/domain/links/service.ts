import { createHash } from 'node:crypto';
import { generateAlias, validateCustomAlias } from './alias.js';
import { validateExpiration } from './expiration.js';
import type { LinksRepository } from './repository.js';
import {
  isGone,
  toResolvedLink,
  type BlocklistChecker,
  type ClickRecorder,
  type CreateLinkResult,
  type DisableResult,
  type LinkCache,
  type LinkService,
  type LookupResult,
  type ResolveResult,
} from './types.js';
import { validateUrl } from './validate.js';

/**
 * Reglas de negocio de los enlaces.
 *
 * Las rutas no deciden nada: llaman aquí y traducen el resultado a HTTP. El
 * servicio orquesta validación, dedupe, cuota, generación/validación de alias,
 * persistencia, caché de resolución y buffer de clics. El SQL vive en
 * `infra/db/links-repository.ts`.
 */

const GENERATED_ALIAS_ATTEMPTS = 5;
export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ACTIVE_LINKS_PER_IP = 50;

export type LinkServiceOptions = {
  repository: LinksRepository;
  now?: (() => Date) | undefined;
  cache?: LinkCache | undefined;
  clickBuffer?: ClickRecorder | undefined;
  blocklist?: BlocklistChecker | undefined;
  dedupeWindowMs?: number | undefined;
  maxActiveLinksPerIp?: number | undefined;
};

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/** 1 h es una estimación conservadora si no hay caducidades próximas. */
const DEFAULT_QUOTA_RETRY_SECONDS = 3_600;

export function createLinkService({
  repository,
  now = () => new Date(),
  cache,
  clickBuffer,
  blocklist,
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
  maxActiveLinksPerIp = DEFAULT_MAX_ACTIVE_LINKS_PER_IP,
}: LinkServiceOptions): LinkService {
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

      // Dedupe, cuota y escritura comparten transacción: dos peticiones
      // simultáneas de la misma IP no pueden saltarse el cupo.
      return repository.withWriteTransaction(async (tx): Promise<CreateLinkResult> => {
        if (createdIpHash !== null) {
          // Dedupe solo para alias generados: si la persona pidió un alias
          // concreto, ese alias manda y la colisión se resuelve aparte.
          if (!wantsCustomAlias) {
            const duplicate = await tx.findRecentDuplicate({
              urlHash,
              createdIpHash,
              expiresAt: expiration.value,
              since: new Date(
                current.getTime() - dedupeWindowMs,
              ).toISOString(),
              currentIso: current.toISOString(),
            });

            if (duplicate) {
              return { ok: true, link: duplicate };
            }
          }

          const activeLinks = await tx.countActiveLinks(
            createdIpHash,
            current.toISOString(),
          );

          if (activeLinks.total >= maxActiveLinksPerIp) {
            // Sin caducidades pendientes no hay un momento exacto de
            // liberación.
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
              : DEFAULT_QUOTA_RETRY_SECONDS;

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
            await tx.insert({
              alias,
              url: validated.value.url,
              urlHash,
              domain: validated.value.domain,
              createdIpHash,
              createdAt: current.toISOString(),
              expiresAt: expiration.value,
            });
          } catch (error) {
            // No dependemos del texto del error: si la fila ya existe, es una
            // colisión de alias; si no, es un fallo real que debe propagarse.
            const existing = await tx.findByAlias(alias);

            if (!existing) throw error;

            if (validatedCustomAlias) {
              return {
                ok: false,
                code: 'alias_taken',
                message: 'Ese alias ya está en uso. Prueba con otro.',
              };
            }

            alias = generateAlias();
            continue;
          }

          const link = await tx.findByAlias(alias);

          if (!link) {
            throw new Error(
              `El enlace ${alias} se insertó pero no se pudo leer`,
            );
          }

          return { ok: true, link };
        }

        throw new Error(
          `No se pudo generar un alias libre tras ${GENERATED_ALIAS_ATTEMPTS} intentos`,
        );
      });
    },

    async resolve(alias, options): Promise<ResolveResult> {
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
      const link = await repository.findByAlias(alias);

      if (!link) return { ok: false, reason: 'not_found' };
      if (isGone(link, current)) return { ok: false, reason: 'gone' };

      const resolved = toResolvedLink(link);
      cache?.set(resolved, current, generation);
      if (recordClick) clickBuffer?.record(alias, current);

      return { ok: true, link: resolved };
    },

    async getMetadata(alias): Promise<LookupResult> {
      const link = await repository.findByAlias(alias);

      if (!link) return { ok: false, reason: 'not_found' };
      if (isGone(link, now())) return { ok: false, reason: 'gone' };

      return { ok: true, link };
    },

    async disable(alias, reason = 'admin_takedown'): Promise<DisableResult> {
      const rowsAffected = await repository.disable(
        alias,
        now().toISOString(),
        reason,
      );

      // Invalidar siempre es barato y evita que una entrada caliente siga
      // redirigiendo si el UPDATE no cambió nada (por ejemplo, un takedown
      // repetido sobre un enlace ya deshabilitado).
      cache?.delete(alias);

      if (rowsAffected > 0) return { ok: true };

      const existing = await repository.findByAlias(alias);

      return existing ? { ok: true } : { ok: false, reason: 'not_found' };
    },

    async disableByDomain(domain, reason = 'domain_blocked') {
      const rowsAffected = await repository.disableByDomain(
        domain.toLowerCase(),
        now().toISOString(),
        reason,
      );

      // La caché no indexa por dominio y su TTL es de 60 s: vaciarla es la
      // forma barata de que ningún enlace retirado siga redirigiendo.
      if (rowsAffected > 0) cache?.clear();

      return rowsAffected;
    },

    invalidate(alias) {
      cache?.delete(alias);
    },
  };
}

