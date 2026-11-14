import { createHash } from 'node:crypto';
import type { Client, Row } from '@libsql/client';
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
 * servicio orquesta validación, generación/validación de alias y persistencia.
 * La caché, el buffer de clics y las cuotas llegarán en fases posteriores.
 */

const GENERATED_ALIAS_ATTEMPTS = 5;
const MIN_EXPIRATION_MS = 5 * 60 * 1000;
const MAX_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;

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
  /** HMAC de la IP; en la Fase 3 todavía no se calcula. */
  createdIpHash?: string | null | undefined;
};

export type CreateLinkErrorCode =
  | UrlErrorCode
  | AliasErrorCode
  | 'alias_taken'
  | 'expiration_invalid';

export type CreateLinkResult =
  | { ok: true; link: LinkRecord }
  | { ok: false; code: CreateLinkErrorCode; message: string };

export type LookupResult =
  | { ok: true; link: LinkRecord }
  | { ok: false; reason: 'not_found' | 'gone' };

export type LinkService = {
  create(input: CreateLinkInput): Promise<CreateLinkResult>;
  resolve(alias: string): Promise<LookupResult>;
  getMetadata(alias: string): Promise<LookupResult>;
};

export type LinkServiceOptions = {
  db: Client;
  now?: (() => Date) | undefined;
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

function isGone(link: LinkRecord, now: Date): boolean {
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
}: LinkServiceOptions): LinkService {
  async function findByAlias(alias: string): Promise<LinkRecord | null> {
    const result = await db.execute({
      sql: `SELECT ${SELECT_COLUMNS} FROM links WHERE alias = ? LIMIT 1`,
      args: [alias],
    });

    const row = result.rows[0];
    return row ? toLinkRecord(row) : null;
  }

  async function lookup(alias: string): Promise<LookupResult> {
    const link = await findByAlias(alias);

    if (!link) return { ok: false, reason: 'not_found' };
    if (isGone(link, now())) return { ok: false, reason: 'gone' };

    return { ok: true, link };
  }

  function validateExpiration(expiresAt: Date | null | undefined): {
    ok: true;
    value: string | null;
  } | {
    ok: false;
    message: string;
  } {
    if (expiresAt === null || expiresAt === undefined) {
      return { ok: true, value: null };
    }

    const timestamp = expiresAt.getTime();

    if (!Number.isFinite(timestamp)) {
      return { ok: false, message: 'La fecha de expiración no es válida.' };
    }

    const current = now().getTime();

    if (timestamp < current + MIN_EXPIRATION_MS) {
      return {
        ok: false,
        message: 'La expiración debe ser al menos 5 minutos posterior a ahora.',
      };
    }

    if (timestamp > current + MAX_EXPIRATION_MS) {
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

      const expiration = validateExpiration(input.expiresAt);

      if (!expiration.ok) {
        return {
          ok: false,
          code: 'expiration_invalid',
          message: expiration.message,
        };
      }

      const customAlias = input.alias?.trim();
      let alias: string;

      if (customAlias !== undefined && customAlias !== '') {
        const validatedAlias = validateCustomAlias(customAlias);

        if (!validatedAlias.ok) {
          return {
            ok: false,
            code: validatedAlias.code,
            message: validatedAlias.message,
          };
        }

        alias = validatedAlias.alias;
      } else {
        alias = generateAlias();
      }

      const urlHash = hashUrl(validated.value.url);
      const createdIpHash = input.createdIpHash ?? null;
      const attempts = customAlias ? 1 : GENERATED_ALIAS_ATTEMPTS;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await db.execute({
            sql: `INSERT INTO links
                    (alias, url, url_hash, domain, created_ip_hash, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
              alias,
              validated.value.url,
              urlHash,
              validated.value.domain,
              createdIpHash,
              expiration.value,
            ],
          });
        } catch (error) {
          // No dependemos del texto del error: si la fila ya existe, es una
          // colisión de alias; si no, es un fallo real que debe propagarse.
          const existing = await findByAlias(alias);

          if (!existing) throw error;

          if (customAlias) {
            return {
              ok: false,
              code: 'alias_taken',
              message: 'Ese alias ya está en uso. Prueba con otro.',
            };
          }

          alias = generateAlias();
          continue;
        }

        const link = await findByAlias(alias);

        if (!link) {
          throw new Error(`El enlace ${alias} se insertó pero no se pudo leer`);
        }

        return { ok: true, link };
      }

      throw new Error(
        `No se pudo generar un alias libre tras ${GENERATED_ALIAS_ATTEMPTS} intentos`,
      );
    },

    resolve(alias) {
      return lookup(alias);
    },

    getMetadata(alias) {
      return lookup(alias);
    },
  };
}
