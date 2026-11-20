import express, { Router, type Response } from 'express';
import type {
  RateLimiter,
  RateLimitRule,
} from '../../security/rate-limit.js';
import {
  createFormToken,
  DEFAULT_FORM_MIN_AGE_MS,
  FORM_HONEYPOT_FIELD,
  FORM_TOKEN_FIELD,
  verifyFormToken,
} from '../../security/form-token.js';
import { CUSTOM_ALIAS_PATTERN } from '../../domain/links/alias.js';
import type {
  CreateLinkErrorCode,
  CreateLinkInput,
  LinkService,
} from '../../domain/links/types.js';
import {
  renderHomePage,
  type CreatedLinkView,
} from '../../ui/pages/home.js';
import {
  enforceCreateRateLimits,
  enforceLookupRateLimits,
  getClientIpHash,
  setRetryAfter,
} from '../middleware/rate-limits.js';
import {
  formatDatetimeLocalUtc,
  getHomeFormLimits,
  parseFormExpiration,
} from '../presenters/home-form.js';
import { buildShortUrl } from '../presenters/links.js';

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

/**
 * En el formulario, cualquier error de validación es un 422 (entidad no
 * procesable); la API distingue 400/409/422 porque un cliente programático
 * necesita esa diferencia.
 */
function formErrorStatus(code: CreateLinkErrorCode): number {
  if (code === 'alias_taken') return 409;
  if (code === 'quota_exceeded') return 429;
  return 422;
}

type HomePageOverrides = {
  created?: CreatedLinkView | null;
  errorMessage?: string | null;
  submittedUrl?: string;
  submittedAlias?: string;
  submittedExpiresAt?: string;
};

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
  const limits = getHomeFormLimits();

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

  /** Único punto que construye respuestas HTML del formulario. */
  function sendHomePage(
    res: Response,
    ipHash: string,
    status: number,
    page: HomePageOverrides = {},
  ): void {
    res
      .status(status)
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(
        renderHomePage({
          ...page,
          limits,
          abuseContactEmail,
          ...formMeta(ipHash),
        }),
      );
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
        sendHomePage(res, ipHash, 429, {
          errorMessage:
            'Demasiadas consultas desde tu conexión. Espera un momento y vuelve a intentarlo.',
        });
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

    sendHomePage(res, ipHash, 200, { created });
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
        sendHomePage(res, ipHash, 400, {
          errorMessage:
            'No se pudo validar el formulario. Recarga la página e inténtalo de nuevo.',
          submittedUrl,
          submittedAlias,
          submittedExpiresAt,
        });
        return;
      }

      const expiration = parseFormExpiration(submittedExpiresAt);

      if (!expiration.ok) {
        sendHomePage(res, ipHash, 422, {
          errorMessage:
            'La fecha de caducidad no es válida. Indícala en UTC o déjala vacía.',
          submittedUrl,
          submittedAlias,
          submittedExpiresAt,
        });
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
        sendHomePage(res, ipHash, 429, {
          errorMessage:
            'Demasiadas creaciones desde tu conexión. Espera un momento y vuelve a intentarlo.',
          submittedUrl,
          submittedAlias,
          submittedExpiresAt,
        });
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
        const status = formErrorStatus(result.code);

        if (result.code === 'quota_exceeded') {
          setRetryAfter(res, {
            rule: 'quota',
            retryAfterSeconds: result.retryAfterSeconds ?? 3_600,
          });
        }

        sendHomePage(res, ipHash, status, {
          errorMessage: result.message,
          submittedUrl,
          submittedAlias,
          submittedExpiresAt,
        });
        return;
      }

      res.redirect(303, `/?created=${encodeURIComponent(result.link.alias)}`);
    },
  );

  return router;
}
