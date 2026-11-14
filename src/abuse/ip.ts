import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Identidad de red para límites, cuotas y dedupe.
 *
 * Express resuelve `req.ip` según `TRUST_PROXY`: detrás de Render hay que
 * confiar en exactamente un proxy; si se configura mal, todos los clientes
 * comparten IP o cualquiera puede falsificar `X-Forwarded-For`.
 *
 * La IP nunca se guarda en claro:
 * - IPv4: se usa tal cual como entrada del HMAC.
 * - IPv6: se agrupa por /64, porque un usuario doméstico suele disponer de
 *   todo un prefijo y podría rotar direcciones sin cambiar de red.
 * - HMAC-SHA256 con un secreto: un hash con sal sería reversible por fuerza
 *   bruta (el espacio IPv4 es pequeño) si se filtra la sal.
 */

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function parseIpv4Groups(value: string): number[] | null {
  const parts = value.split('.');

  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));

  if (
    octets.some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return null;
  }

  return octets;
}

/** Expande una IPv6 a 8 grupos de 16 bits; acepta IPv4 embebida. */
function expandIpv6(value: string): number[] | null {
  const withoutZone = value.split('%')[0] ?? '';

  if (withoutZone.includes('::') && withoutZone.split('::').length > 2) {
    return null;
  }

  const [headRaw = '', tailRaw = ''] = withoutZone.split('::');
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === '' ? [] : tailRaw.split(':');

  const parseGroups = (parts: string[]): number[] | null => {
    const groups: number[] = [];

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';

      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;

        const octets = parseIpv4Groups(part);
        if (!octets) return null;

        groups.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }

    return groups;
  };

  const preparedHead = parseGroups(head);
  const preparedTail = parseGroups(tail);

  if (!preparedHead || !preparedTail) return null;

  const compressed = withoutZone.includes('::');
  const missing = 8 - preparedHead.length - preparedTail.length;

  if (compressed ? missing < 1 : missing !== 0) return null;

  const groups = [
    ...preparedHead,
    ...Array<number>(compressed ? missing : 0).fill(0),
    ...preparedTail,
  ];

  return groups.length === 8 ? groups : null;
}

function formatIpv6(groups: readonly number[]): string {
  return groups.map((group) => group.toString(16)).join(':');
}

/**
 * Normaliza la IP para comparaciones: quita zone id, convierte IPv4-mapped a
 * IPv4 y expande IPv6 a su forma completa. Las IPv4-mapped aparecen a menudo
 * cuando Node escucha en dual-stack (`::ffff:127.0.0.1`).
 */
export function normalizeClientIp(raw: string | null | undefined): string {
  const value = raw?.trim() ?? '';

  if (value === '') return 'unknown';

  const withoutZone = value.split('%')[0] ?? '';

  const mapped = IPV4_MAPPED.exec(withoutZone);
  if (mapped?.[1]) return mapped[1];

  if (isIP(withoutZone) === 6) {
    const groups = expandIpv6(withoutZone);
    if (groups) return formatIpv6(groups);
  }

  return withoutZone.toLowerCase();
}

/**
 * Clave que se hashea: IPv4 normalizada o prefijo /64 de IPv6. Así dos
 * direcciones del mismo /64 consumen la misma cuota.
 */
export function ipKey(raw: string | null | undefined): string {
  const normalized = normalizeClientIp(raw);

  if (isIP(normalized) !== 6) return normalized;

  const groups = expandIpv6(normalized);
  if (!groups) return normalized;

  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');

  return `${prefix}::/64`;
}

/** HMAC-SHA256(secreto, clave de IP) en hexadecimal. */
export function hashIp(
  secret: string,
  raw: string | null | undefined,
): string {
  return createHmac('sha256', secret).update(ipKey(raw)).digest('hex');
}

type IpRequest = {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
};

/**
 * IP que Express consideró fiable tras aplicar `trust proxy`. El fallback al
 * socket cubre entornos sin `req.ip`; `unknown` agrupa a los no identificables
 * en vez de dejarlos fuera de los límites.
 */
export function getClientIp(req: IpRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
