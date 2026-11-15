import { Router } from 'express';
import { z } from 'zod';
import type {
  RateLimiter,
  RateLimitRule,
} from '../abuse/rate-limit.js';
import {
  type CreateLinkErrorCode,
  type CreateLinkInput,
  type LinkService,
} from '../links/service.js';
import { CUSTOM_ALIAS_PATTERN } from '../links/alias.js';
import {
  enforceCreateRateLimits,
  enforceLookupRateLimits,
  getClientIpHash,
  setRetryAfter,
  toLinkResponse,
} from './shared.js';

const createLinkSchema = z
  .object({
    url: z.string().trim().min(1).max(4096),
    alias: z.string().trim().min(1).max(32).optional(),
    expiresAt: z
      .union([z.iso.datetime({ offset: true }), z.null()])
      .optional(),
  })
  .strict();

const CREATE_ERROR_STATUS: Record<CreateLinkErrorCode, number> = {
  url_required: 400,
  url_too_long: 400,
  url_invalid: 400,
  url_scheme: 400,
  url_credentials: 400,
  url_local: 400,
  url_private_ip: 400,
  alias_invalid: 400,
  alias_reserved: 400,
  alias_taken: 409,
  domain_blocked: 422,
  expiration_invalid: 400,
  quota_exceeded: 429,
};

export type ApiLinksRouterOptions = {
  service: LinkService;
  baseUrl: string;
  rateLimiter: RateLimiter;
  ipHashSecret: string;
  createIpRules: readonly RateLimitRule[];
  createGlobalRules: readonly RateLimitRule[];
  lookupIpRules: readonly RateLimitRule[];
  now: () => Date;
};

export function createApiLinksRouter({
  service,
  baseUrl,
  rateLimiter,
  ipHashSecret,
  createIpRules,
  createGlobalRules,
  lookupIpRules,
  now,
}: ApiLinksRouterOptions): Router {
  const router = Router();

  // Metadata, errores y redirecciones de la API nunca deben cachearse: una
  // respuesta vieja podría mostrar clics o estados ya cambiados.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/links', async (req, res) => {
    const ipHash = getClientIpHash(req, ipHashSecret);
    const parsed = createLinkSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'El cuerpo de la petición no es válido.',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      });
      return;
    }

    // El límite se consume después de Zod: un cuerpo inválido no debe gastar
    // la cuota de creación de una IP legítima.
    const limited = enforceCreateRateLimits(
      rateLimiter,
      ipHash,
      createIpRules,
      createGlobalRules,
      now().getTime(),
    );

    if (limited) {
      setRetryAfter(res, limited);
      res.status(429).json({
        error: 'rate_limited',
        message: 'Demasiadas creaciones. Inténtalo de nuevo más tarde.',
        retryAfter: limited.retryAfterSeconds,
      });
      return;
    }

    const input: CreateLinkInput = {
      url: parsed.data.url,
      createdIpHash: ipHash,
    };

    if (parsed.data.alias !== undefined) {
      input.alias = parsed.data.alias;
    }

    if (parsed.data.expiresAt !== undefined) {
      input.expiresAt =
        parsed.data.expiresAt === null
          ? null
          : new Date(parsed.data.expiresAt);
    }

    const result = await service.create(input);

    if (!result.ok) {
      if (result.code === 'quota_exceeded') {
        // La cuota se libera cuando caducan enlaces: el servicio devuelve una
        // estimación; si no hay caducidades, usa un valor conservador.
        setRetryAfter(res, {
          rule: 'quota',
          retryAfterSeconds: result.retryAfterSeconds ?? 3_600,
        });
      }

      res.status(CREATE_ERROR_STATUS[result.code]).json({
        error: result.code,
        message: result.message,
      });
      return;
    }

    const payload = toLinkResponse(result.link, baseUrl);

    res
      .status(201)
      .location(`/api/v1/links/${encodeURIComponent(result.link.alias)}`)
      .json(payload);
  });

  router.get('/links/:alias', async (req, res) => {
    const limited = enforceLookupRateLimits(
      rateLimiter,
      getClientIpHash(req, ipHashSecret),
      lookupIpRules,
      now().getTime(),
    );

    if (limited) {
      setRetryAfter(res, limited);
      res.status(429).json({
        error: 'rate_limited',
        message: 'Demasiadas consultas. Inténtalo de nuevo más tarde.',
        retryAfter: limited.retryAfterSeconds,
      });
      return;
    }

    const alias = req.params.alias ?? '';

    // Un alias que no puede existir no merece una consulta a la DB.
    if (!CUSTOM_ALIAS_PATTERN.test(alias)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const result = await service.getMetadata(alias);

    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 410).json({
        error: result.reason === 'not_found' ? 'not_found' : 'gone',
      });
      return;
    }

    res.status(200).json(toLinkResponse(result.link, baseUrl));
  });

  return router;
}
