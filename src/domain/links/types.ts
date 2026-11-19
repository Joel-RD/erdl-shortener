import type { AliasErrorCode } from './alias.js';
import type { UrlErrorCode } from './validate.js';

/**
 * Modelo y contratos del dominio de enlaces.
 *
 * Este módulo no conoce Express, SQL ni el sistema de archivos: solo describe
 * los datos que maneja el servicio y los puertos que la infraestructura debe
 * implementar.
 */

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

/** Puerto de caché de resolución; lo implementa `infra/cache`. */
export type LinkCache = {
  get(alias: string, at?: Date): ResolvedLink | undefined;
  set(link: ResolvedLink, at?: Date, expectedGeneration?: number): void;
  delete(alias: string): void;
  clear(): void;
  readonly generation: number;
};

/** Puerto de registro de clics; lo implementa `infra/clicks`. */
export type ClickRecorder = {
  record(alias: string, at?: Date): void;
};

/** Puerto de consulta de la blocklist; lo implementa `infra/db`. */
export type BlocklistChecker = {
  isBlocked(domain: string): Promise<boolean>;
};

export function toResolvedLink(link: LinkRecord): ResolvedLink {
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

export function isGone(
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
