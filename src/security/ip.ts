import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { parseIpv6Groups } from '../net/ip.js';

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
    const groups = parseIpv6Groups(withoutZone);
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

  const groups = parseIpv6Groups(normalized);
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
