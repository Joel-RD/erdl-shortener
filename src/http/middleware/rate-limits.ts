import type { Request, RequestHandler } from 'express';
import { getClientIp, hashIp } from '../../security/ip.js';
import { renderErrorPage } from '../../ui/pages/error.js';
import { wantsHtml } from '../negotiation.js';
import {
  consumeRules,
  type RateLimiter,
  type RateLimitRejection,
  type RateLimitRule,
} from '../../security/rate-limit.js';

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

export type RequestRateLimitOptions = {
  limiter: RateLimiter;
  ipHashSecret: string;
  rules: readonly RateLimitRule[];
  now: () => Date;
  abuseContactEmail?: string | undefined;
};

/**
 * Freno de peticiones mutantes ANTES de los body parsers: un flood de cuerpos
 * grandes no debe llegar a express.json ni a la validación.
 */
export function createRequestRateLimit({
  limiter,
  ipHashSecret,
  rules,
  now,
  abuseContactEmail,
}: RequestRateLimitOptions): RequestHandler {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const limited = enforceRequestRateLimits(
      limiter,
      getClientIpHash(req, ipHashSecret),
      rules,
      now().getTime(),
    );

    if (!limited) {
      next();
      return;
    }

    setRetryAfter(res, limited);

    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(429)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status: 429,
            title: 'Demasiadas peticiones',
            message:
              'Has hecho demasiadas peticiones seguidas. Espera un momento y vuelve a intentarlo.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res
      .status(429)
      .set('Cache-Control', 'no-store')
      .json({
        error: 'rate_limited',
        message: 'Demasiadas peticiones. Inténtalo de nuevo más tarde.',
        retryAfter: limited.retryAfterSeconds,
      });
  };
}
