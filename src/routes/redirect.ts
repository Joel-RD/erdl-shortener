import { Router } from 'express';
import type { LinkService } from '../links/service.js';
import { renderErrorPage } from '../ui/pages.js';
import { wantsHtml } from './shared.js';

export type RedirectRouterOptions = {
  service: LinkService;
  abuseContactEmail?: string | undefined;
};

export function createRedirectRouter({
  service,
  abuseContactEmail,
}: RedirectRouterOptions): Router {
  const router = Router();

  router.get('/:alias', async (req, res) => {
    const alias = req.params.alias ?? '';
    const result = await service.resolve(alias);

    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
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
