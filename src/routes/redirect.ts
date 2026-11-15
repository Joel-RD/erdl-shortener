import { Router } from 'express';
import type {
  RateLimiter,
  RateLimitRule,
} from '../abuse/rate-limit.js';
import type { LinkService } from '../links/service.js';
import { CUSTOM_ALIAS_PATTERN } from '../links/alias.js';
import { renderErrorPage } from '../ui/pages.js';
import {
  enforceRedirectRateLimits,
  getClientIpHash,
  setRetryAfter,
  wantsHtml,
} from './shared.js';

export type RedirectRouterOptions = {
  service: LinkService;
  abuseContactEmail?: string | undefined;
  rateLimiter: RateLimiter;
  ipHashSecret: string;
  redirectIpRules: readonly RateLimitRule[];
  now: () => Date;
};

export function createRedirectRouter({
  service,
  abuseContactEmail,
  rateLimiter,
  ipHashSecret,
  redirectIpRules,
  now,
}: RedirectRouterOptions): Router {
  const router = Router();

  router.get('/:alias', async (req, res) => {
    const ipHash = getClientIpHash(req, ipHashSecret);
    const limited = enforceRedirectRateLimits(
      rateLimiter,
      ipHash,
      redirectIpRules,
      now().getTime(),
    );

    if (limited) {
      res.set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      setRetryAfter(res, limited);

      if (wantsHtml(req)) {
        res
          .status(429)
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

      res.status(429).json({
        error: 'rate_limited',
        message: 'Demasiadas peticiones. Inténtalo de nuevo más tarde.',
        retryAfter: limited.retryAfterSeconds,
      });
      return;
    }

    const alias = req.params.alias ?? '';

    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });

    // Un alias imposible no toca la DB. La comprobación de patrón es barata y
    // evita que rutas como /favicon.ico o /robots.txt lleguen a libSQL.
    if (!CUSTOM_ALIAS_PATTERN.test(alias)) {
      if (wantsHtml(req)) {
        res
          .status(404)
          .type('html')
          .send(
            renderErrorPage({
              status: 404,
              title: 'Ese enlace no existe',
              message:
                'No encontramos ningún enlace con ese alias. Revisa que esté bien escrito.',
              abuseContactEmail,
            }),
          );
        return;
      }

      res.status(404).json({ error: 'not_found' });
      return;
    }

    const result = await service.resolve(alias, {
      // Un HEAD no es una visita: no debe inflar el contador de clics.
      recordClick: req.method !== 'HEAD',
    });

    if (result.ok) {
      res.redirect(302, result.link.url);
      return;
    }

    const notFound = result.reason === 'not_found';

    if (wantsHtml(req)) {
      res
        .status(notFound ? 404 : 410)
        .type('html')
        .send(
          renderErrorPage({
            status: notFound ? 404 : 410,
            title: notFound
              ? 'Ese enlace no existe'
              : 'Este enlace ya no está disponible',
            message: notFound
              ? 'No encontramos ningún enlace con ese alias. Revisa que esté bien escrito.'
              : 'El enlace existió, pero caducó o fue retirado. No se puede reactivar.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res.status(notFound ? 404 : 410).json({
      error: notFound ? 'not_found' : 'gone',
    });
  });

  return router;
}
