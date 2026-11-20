import {
  CUSTOM_ALIAS_PATTERN,
  MAX_CUSTOM_ALIAS_LENGTH,
  MIN_CUSTOM_ALIAS_LENGTH,
} from '../../domain/links/alias.js';
import {
  MAX_EXPIRATION_MS,
  MIN_EXPIRATION_MS,
} from '../../domain/links/expiration.js';
import { MAX_URL_LENGTH } from '../../domain/links/validate.js';
import type { HomeFormLimits } from '../../ui/pages/home.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 365;

/**
 * Límites del formulario derivados de las reglas del dominio. La UI no importa
 * `domain/`, así que recibe estos valores ya calculados.
 */
export function getHomeFormLimits(): HomeFormLimits {
  const maxExpirationDays = MAX_EXPIRATION_MS / DAY_MS;
  const minExpirationMinutes = MIN_EXPIRATION_MS / 60_000;
  const maxExpirationYears = maxExpirationDays / YEAR_DAYS;

  return {
    urlMaxLength: MAX_URL_LENGTH,
    aliasMinLength: MIN_CUSTOM_ALIAS_LENGTH,
    aliasMaxLength: MAX_CUSTOM_ALIAS_LENGTH,
    // `pattern` no necesita anclas: el navegador ya exige coincidencia completa.
    aliasPattern: CUSTOM_ALIAS_PATTERN.source.replace(/^\^|\$$/g, ''),
    expirationMinLabel: `${minExpirationMinutes} ${
      minExpirationMinutes === 1 ? 'minuto' : 'minutos'
    }`,
    expirationMaxLabel:
      maxExpirationDays % YEAR_DAYS === 0
        ? `${maxExpirationYears} ${
            maxExpirationYears === 1 ? 'año' : 'años'
          }`
        : `${maxExpirationDays} días`,
  };
}

/** `YYYY-MM-DDTHH:mm` en UTC, el formato que entiende datetime-local. */
export function formatDatetimeLocalUtc(date: Date): string {
  return date.toISOString().slice(0, 16);
}

/**
 * Convierte el valor de `<input type="datetime-local">` en una fecha UTC.
 * El formulario dice «UTC» de forma explícita: sin zona horaria del cliente
 * no hay manera fiable de interpretar otra cosa.
 */
export function parseFormExpiration(
  raw: string,
): { ok: true; value: Date | null } | { ok: false } {
  const value = raw.trim();

  if (value === '') return { ok: true, value: null };

  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);

  if (match === null) return { ok: false };

  const minute = match[1] ?? '';
  const seconds = match[2] ?? '00';
  const date = new Date(`${minute}:${seconds}.000Z`);

  // `new Date` normaliza fechas imposibles (31 de febrero → marzo). Comparar
  // el ida y vuelta detecta esos casos y los rechaza.
  if (
    !Number.isFinite(date.getTime()) ||
    formatDatetimeLocalUtc(date) !== minute
  ) {
    return { ok: false };
  }

  return { ok: true, value: date };
}
