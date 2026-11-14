import { randomInt } from 'node:crypto';

/**
 * Reglas de alias.
 *
 * - Generado: 7 caracteres base62 con `randomInt` (criptográfico).
 * - Personalizado: 3–32 caracteres `[A-Za-z0-9_-]`.
 * - Reservados: nombres que ya ocupan una ruta o un archivo estático.
 */

export const GENERATED_ALIAS_LENGTH = 7;
export const MIN_CUSTOM_ALIAS_LENGTH = 3;
export const MAX_CUSTOM_ALIAS_LENGTH = 32;
export const CUSTOM_ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * La comparación es en minúsculas porque Express no distingue mayúsculas en
 * las rutas: `/API` también llegaría al router de la API.
 */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app.js',
  'favicon.ico',
  'favicon.svg',
  'health',
  'links',
  'report',
  'robots.txt',
  'sitemap.xml',
  'static',
  'styles.css',
]);

export type AliasErrorCode = 'alias_invalid' | 'alias_reserved';

export type AliasValidationResult =
  | { ok: true; alias: string }
  | { ok: false; code: AliasErrorCode; message: string };

export function generateAlias(
  length: number = GENERATED_ALIAS_LENGTH,
): string {
  let alias = '';

  for (let index = 0; index < length; index += 1) {
    alias += BASE62.charAt(randomInt(0, BASE62.length));
  }

  return alias;
}

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias.toLowerCase());
}

/**
 * Valida un alias escrito por la persona. No consulta la DB: la colisión se
 * resuelve en el servicio, porque depende del estado persistido.
 */
export function validateCustomAlias(raw: string): AliasValidationResult {
  const alias = raw.trim();

  if (!CUSTOM_ALIAS_PATTERN.test(alias)) {
    return {
      ok: false,
      code: 'alias_invalid',
      message:
        'El alias debe tener entre 3 y 32 caracteres: letras, números, guion o guion bajo.',
    };
  }

  if (isReservedAlias(alias)) {
    return {
      ok: false,
      code: 'alias_reserved',
      message: 'Ese alias está reservado. Prueba con otro.',
    };
  }

  return { ok: true, alias };
}
