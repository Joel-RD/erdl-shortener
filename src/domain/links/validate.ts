import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';
import { isPrivateAddress } from './private-address.js';

/**
 * Validación y normalización pura de URLs.
 *
 * Entra texto tal cual lo escribió una persona; sale una URL canónica o un
 * error con un código estable. No toca la DB ni HTTP: eso permite probar los
 * casos peligrosos (IP privada, esquema `javascript:`, credenciales) en una
 * tabla sin levantar el servidor.
 */

export const MAX_URL_LENGTH = 4096;

export type UrlErrorCode =
  | 'url_required'
  | 'url_too_long'
  | 'url_invalid'
  | 'url_scheme'
  | 'url_credentials'
  | 'url_local'
  | 'url_private_ip';

export type NormalizedUrl = {
  /** URL canónica que se guarda y se usa como destino del redirect. */
  url: string;
  /** Host ASCII (punycode), en minúsculas y sin punto final. */
  host: string;
  /** Dominio registrable (`a.b.example.co.uk` → `example.co.uk`). */
  domain: string;
};

export type UrlValidationResult =
  | { ok: true; value: NormalizedUrl }
  | { ok: false; code: UrlErrorCode; message: string };

const ERROR_MESSAGES: Record<UrlErrorCode, string> = {
  url_required: 'Escribe una URL.',
  url_too_long: `La URL supera el límite de ${MAX_URL_LENGTH} caracteres.`,
  url_invalid: 'La URL no tiene un formato válido.',
  url_scheme: 'Solo se permiten enlaces http o https.',
  url_credentials: 'La URL no puede incluir usuario ni contraseña.',
  url_local: 'No se permiten direcciones locales o internas.',
  url_private_ip: 'No se permiten direcciones IP privadas o reservadas.',
};

function fail(code: UrlErrorCode): UrlValidationResult {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function isLocalHostname(host: string): boolean {
  const normalized = host.replace(/\.+$/, '');

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local') ||
    normalized === 'internal' ||
    normalized.endsWith('.internal') ||
    // home.arpa es el dominio reservado para redes domésticas (RFC 8375).
    normalized === 'home.arpa' ||
    normalized.endsWith('.home.arpa') ||
    // Sufijos usados en redes privadas que nunca deben resolver en Internet.
    normalized.endsWith('.lan') ||
    normalized.endsWith('.corp') ||
    normalized.endsWith('.home') ||
    normalized.endsWith('.intranet') ||
    normalized.endsWith('.private')
  );
}

/**
 * Normaliza y valida una URL:
 *
 * 1. Rechaza vacíos y longitudes fuera de rango.
 * 2. Parsea con `URL` (normaliza mayúsculas, puertos y escapes).
 * 3. Solo http/https, sin credenciales.
 * 4. Convierte el host a ASCII para evitar homógrafos y dominios engañosos.
 * 5. Rechaza localhost y direcciones privadas/reservadas.
 */
export function validateUrl(raw: string): UrlValidationResult {
  const trimmed = raw.trim();

  if (trimmed === '') return fail('url_required');
  if (trimmed.length > MAX_URL_LENGTH) return fail('url_too_long');

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return fail('url_invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('url_scheme');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return fail('url_credentials');
  }

  // `hostname` incluye corchetes en IPv6 (`[::1]`). Las IP no pasan por
  // domainToASCII (una IPv6 devolvería cadena vacía).
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
  const asciiHost = isIP(rawHost) ? rawHost : domainToASCII(rawHost);

  if (asciiHost === '') return fail('url_invalid');

  // Un punto final es un FQDN válido, pero también un bypass de blocklist.
  // Se elimina antes de guardar para que todos vean el mismo dominio.
  const host = isIP(asciiHost)
    ? asciiHost
    : asciiHost.toLowerCase().replace(/\.+$/, '');

  if (host === '') return fail('url_invalid');

  if (isLocalHostname(host) || isPrivateAddress(host)) {
    return fail(
      isLocalHostname(host) ? 'url_local' : 'url_private_ip',
    );
  }

  // Un nombre de un solo segmento puede resolverse vía sufijo de búsqueda
  // interno. Los dominios públicos y las IP (ya validadas) llevan punto.
  if (isIP(host) === 0 && !host.includes('.')) {
    return fail('url_local');
  }

  try {
    parsed.hostname = host;
  } catch {
    return fail('url_invalid');
  }

  const normalized = parsed.href;

  if (normalized.length > MAX_URL_LENGTH) return fail('url_too_long');

  const domain = getDomain(host, { allowPrivateDomains: false }) ?? host;

  return {
    ok: true,
    value: {
      url: normalized,
      host,
      domain: domain.toLowerCase(),
    },
  };
}
