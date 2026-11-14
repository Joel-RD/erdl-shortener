import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';

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

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  return (
    a === 0 || // "esta red"
    a === 10 || // privada
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (incluye metadata cloud)
    (a === 172 && b >= 16 && b <= 31) || // privada
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentación
    (a === 192 && b === 88 && c === 99) || // relay 6to4
    (a === 192 && b === 168) || // privada
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentación
    (a === 203 && b === 0 && c === 113) || // documentación
    a >= 224 // multicast, reservada y broadcast
  );
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return null;
  }

  return octets;
}

/** Expande una IPv6 a 16 bytes; devuelve null si la forma no es válida. */
function parseIpv6(value: string): number[] | null {
  const withoutZone = value.split('%')[0] ?? '';

  if (withoutZone.includes('::') && withoutZone.split('::').length > 2) {
    return null;
  }

  const [headRaw = '', tailRaw = ''] = withoutZone.split('::');
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === '' ? [] : tailRaw.split(':');

  const prepare = (parts: string[]): string[] | null => {
    const copy = [...parts];
    const last = copy.at(-1);

    if (last?.includes('.')) {
      const ipv4 = parseIpv4(last);
      if (!ipv4) return null;

      const [a = 0, b = 0, c = 0, d = 0] = ipv4;
      copy.splice(
        copy.length - 1,
        1,
        ((a << 8) | b).toString(16),
        ((c << 8) | d).toString(16),
      );
    }

    return copy;
  };

  const preparedHead = prepare(head);
  const preparedTail = prepare(tail);
  if (!preparedHead || !preparedTail) return null;

  const hasCompression = withoutZone.includes('::');
  const missing = 8 - preparedHead.length - preparedTail.length;

  if (hasCompression ? missing < 1 : missing !== 0) return null;

  const groups = [
    ...preparedHead,
    ...Array<string>(hasCompression ? missing : 0).fill('0'),
    ...preparedTail,
  ];

  if (groups.length !== 8) return null;

  const bytes: number[] = [];

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return bytes;
}

function isPrivateIpv6(bytes: readonly number[]): boolean {
  if (bytes.length !== 16) return false;

  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) &&
    bytes[15] === 1;

  if (allZero || loopback) return true;

  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal =
    bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  const documentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;

  if (uniqueLocal || linkLocal || multicast || documentation) return true;

  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  const ipv4Mapped =
    firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;

  if (ipv4Mapped) {
    return isPrivateIpv4(bytes.slice(12));
  }

  // IPv4-compatible (::a.b.c.d), formato antiguo pero todavía interpretable.
  const firstTwelveZero = bytes.slice(0, 12).every((byte) => byte === 0);
  if (firstTwelveZero) return isPrivateIpv4(bytes.slice(12));

  // 6to4 (2002::/16) lleva una IPv4 embebida en los bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(bytes.slice(2, 6));
  }

  // NAT64 well-known prefix (64:ff9b::/96) lleva la IPv4 al final.
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);

  if (nat64) return isPrivateIpv4(bytes.slice(12));

  return false;
}

function isPrivateAddress(host: string): boolean {
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (ipv6) return isPrivateIpv6(ipv6);

  return false;
}

function isLocalHostname(host: string): boolean {
  const normalized = host.replace(/\.+$/, '');

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
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
