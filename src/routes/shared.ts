import type { Request } from 'express';
import { getClientIp, hashIp } from '../abuse/ip.js';
import {
  consumeRules,
  type RateLimiter,
  type RateLimitRejection,
  type RateLimitRule,
} from '../abuse/rate-limit.js';
import type { LinkRecord, PublicLink } from '../links/service.js';
import { toPublicLink } from '../links/service.js';

export function buildShortUrl(baseUrl: string, alias: string): string {
  return `${baseUrl}/${encodeURIComponent(alias)}`;
}

/**
 * Negociación mínima: un navegador manda `text/html`; curl y los clientes de
 * API no. Así `GET /:alias` puede devolver una página bonita o JSON sin
 * duplicar rutas.
 */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/** La IP fiable ya resuelta por Express (según TRUST_PROXY), en HMAC. */
export function getClientIpHash(req: Request, secret: string): string {
  return hashIp(secret, getClientIp(req));
}

/**
 * Consume las reglas de creación: primero las de la IP y después las globales.
 * Devolver la primera rechazada permite mandar su `Retry-After` exacto.
 */
export function enforceCreateRateLimits(
  limiter: RateLimiter,
  ipHash: string,
  ipRules: readonly RateLimitRule[],
  globalRules: readonly RateLimitRule[],
  nowMs: number,
): RateLimitRejection | null {
  return (
    consumeRules(limiter, `create:ip:${ipHash}`, ipRules, nowMs) ??
    consumeRules(limiter, 'create:global', globalRules, nowMs)
  );
}

export function enforceRedirectRateLimits(
  limiter: RateLimiter,
  ipHash: string,
  rules: readonly RateLimitRule[],
  nowMs: number,
): RateLimitRejection | null {
  return consumeRules(limiter, `redirect:ip:${ipHash}`, rules, nowMs);
}

/**
 * Peticiones mutantes antes de parsear el cuerpo. Es un freno grueso: los
 * límites finos (creación, redirect, lookup) se siguen aplicando en su ruta.
 */
export function enforceRequestRateLimits(
  limiter: RateLimiter,
  ipHash: string,
  rules: readonly RateLimitRule[],
  nowMs: number,
): RateLimitRejection | null {
  return consumeRules(limiter, `request:ip:${ipHash}`, rules, nowMs);
}

export function enforceLookupRateLimits(
  limiter: RateLimiter,
  ipHash: string,
  rules: readonly RateLimitRule[],
  nowMs: number,
): RateLimitRejection | null {
  return consumeRules(limiter, `lookup:ip:${ipHash}`, rules, nowMs);
}

export function setRetryAfter(
  res: { set(field: string, value: string): unknown },
  rejection: RateLimitRejection,
): void {
  res.set('Retry-After', String(rejection.retryAfterSeconds));
}

export type LinkResponse = PublicLink & { shortUrl: string };

export function toLinkResponse(
  link: LinkRecord,
  baseUrl: string,
): LinkResponse {
  return {
    ...toPublicLink(link),
    shortUrl: buildShortUrl(baseUrl, link.alias),
  };
}
