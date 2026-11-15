import express, { Router } from 'express';
import type {
  RateLimiter,
  RateLimitRule,
} from '../abuse/rate-limit.js';
import {
  createFormToken,
  DEFAULT_FORM_MIN_AGE_MS,
  FORM_HONEYPOT_FIELD,
  FORM_TOKEN_FIELD,
  verifyFormToken,
} from '../abuse/form-token.js';
import { CUSTOM_ALIAS_PATTERN } from '../links/alias.js';
import type { CreateLinkInput, LinkService } from '../links/service.js';
import { renderHomePage, type CreatedLinkView } from '../ui/pages.js';
import {
  buildShortUrl,
  enforceCreateRateLimits,
  enforceLookupRateLimits,
  getClientIpHash,
  setRetryAfter,
} from './shared.js';

export type PagesRouterOptions = {
  service: LinkService;
  baseUrl: string;
  abuseContactEmail?: string | undefined;
  rateLimiter: RateLimiter;
  ipHashSecret: string;
  formTokenSecret: string;
  createIpRules: readonly RateLimitRule[];
  createGlobalRules: readonly RateLimitRule[];
  lookupIpRules: readonly RateLimitRule[];
  now: () => Date;
  /** En tests se pone 0 para no esperar; en producción vale 3 s. */
  formTokenMinAgeMs?: number | undefined;
};

function firstQueryValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function firstBodyValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

export function createPagesRouter({
  service,
  baseUrl,
  abuseContactEmail,
  rateLimiter,
  ipHashSecret,
  formTokenSecret,
  createIpRules,
  createGlobalRules,
  lookupIpRules,
  now,
  formTokenMinAgeMs = DEFAULT_FORM_MIN_AGE_MS,
}: PagesRouterOptions): Router {
  const router = Router();

  function formMeta(ipHash: string): {
    formToken: string;
    minExpiration: string;
  } {
    const current = now();

    return {
      formToken: createFormToken(formTokenSecret, current, ipHash),
      // 6 min y no 5: el mínimo del servicio se evalúa al recibir el POST,
      // así que el borde exacto de 5 min podría rechazarse por latencia.
      minExpiration: formatDatetimeLocalUtc(
        new Date(current.getTime() + 6 * 60 * 1000),
      ),
    };
  }

  router.get('/', async (req, res) => {
    const requestedAlias = firstQueryValue(req.query.created);
    const ipHash = getClientIpHash(req, ipHashSecret);
    let created: CreatedLinkView | null = null;

    // La tarjeta de "enlace creado" no debe indexarse: contiene un alias que
    // solo debe ver quien acaba de crearlo (aunque cualquiera pueda adivinarlo).
    if (requestedAlias !== null) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }

    if (requestedAlias && CUSTOM_ALIAS_PATTERN.test(requestedAlias)) {
      // Solo la consulta con alias toca la DB; la portada sola no se limita.
      const limited = enforceLookupRateLimits(
        rateLimiter,
        ipHash,
        lookupIpRules,
        now().getTime(),
      );

      if (limited) {
        setRetryAfter(res, limited);
        res
          .status(429)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            renderHomePage({
              errorMessage:
                'Demasiadas consultas desde tu conexión. Espera un momento y vuelve a intentarlo.',
              abuseContactEmail,
              ...formMeta(ipHash),
            }),
          );
        return;
      }

      const result = await service.getMetadata(requestedAlias);

      if (result.ok) {
        created = {
          alias: result.link.alias,
          shortUrl: buildShortUrl(baseUrl, result.link.alias),
          url: result.link.url,
          clicks: result.link.clicks,
          createdAt: result.link.createdAt,
          expiresAt: result.link.expiresAt,
        };
      }
    }

    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(
        renderHomePage({
          created,
          abuseContactEmail,
          ...formMeta(ipHash),
        }),
      );
  });

  // El parser de formularios se monta SOLO en esta ruta: la API es JSON-only y
  // el resto de la app no necesita aceptar urlencoded.
  router.post(
    '/links',
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req, res) => {
      const ipHash = getClientIpHash(req, ipHashSecret);
      const submittedUrl = firstBodyValue(req.body?.url);
      const submittedAlias = firstBodyValue(req.body?.alias).trim();
      const submittedExpiresAt = firstBodyValue(req.body?.expiresAt);
      const honeypot = firstBodyValue(req.body?.[FORM_HONEYPOT_FIELD]).trim();
      const formToken = req.body?.[FORM_TOKEN_FIELD];
      const tokenStatus = verifyFormToken(formTokenSecret, formToken, {
        now: now(),
        minAgeMs: formTokenMinAgeMs,
        context: ipHash,
      });

      // El campo trampa relleno o un token ausente/manipulado/de otra IP
      // descartan el envío sin crear nada. El mensaje es genérico.
      if (honeypot !== '' || tokenStatus !== 'valid') {
        res
          .status(400)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            renderHomePage({
              errorMessage:
                'No se pudo validar el formulario. Recarga la página e inténtalo de nuevo.',
              submittedUrl,
              submittedAlias,
              submittedExpiresAt,
              abuseContactEmail,
              ...formMeta(ipHash),
            }),
          );
        return;
      }

      const expiration = parseFormExpiration(submittedExpiresAt);

      if (!expiration.ok) {
        res
          .status(422)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            renderHomePage({
              errorMessage:
                'La fecha de caducidad no es válida. Indícala en UTC o déjala vacía.',
              submittedUrl,
              submittedAlias,
              submittedExpiresAt,
              abuseContactEmail,
              ...formMeta(ipHash),
            }),
          );
        return;
      }

      // Igual que en la API: validar primero y consumir cuota después, para
      // que un envío inválido no agote el límite de una IP legítima.
      const limited = enforceCreateRateLimits(
        rateLimiter,
        ipHash,
        createIpRules,
        createGlobalRules,
        now().getTime(),
      );

      if (limited) {
        setRetryAfter(res, limited);
        res
          .status(429)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            renderHomePage({
              errorMessage:
                'Demasiadas creaciones desde tu conexión. Espera un momento y vuelve a intentarlo.',
              submittedUrl,
              submittedAlias,
              submittedExpiresAt,
              abuseContactEmail,
              ...formMeta(ipHash),
            }),
          );
        return;
      }

      const input: CreateLinkInput = {
        url: submittedUrl,
        createdIpHash: ipHash,
      };

      if (submittedAlias !== '') input.alias = submittedAlias;
      if (expiration.value !== null) input.expiresAt = expiration.value;

      const result = await service.create(input);

      if (!result.ok) {
        const status =
          result.code === 'alias_taken'
            ? 409
            : result.code === 'quota_exceeded'
              ? 429
              : 422;

        if (result.code === 'quota_exceeded') {
          setRetryAfter(res, {
            rule: 'quota',
            retryAfterSeconds: result.retryAfterSeconds ?? 3_600,
          });
        }

        res
          .status(status)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            renderHomePage({
              errorMessage: result.message,
              submittedUrl,
              submittedAlias,
              submittedExpiresAt,
              abuseContactEmail,
              ...formMeta(ipHash),
            }),
          );
        return;
      }

      res.redirect(303, `/?created=${encodeURIComponent(result.link.alias)}`);
    },
  );

  return router;
}
