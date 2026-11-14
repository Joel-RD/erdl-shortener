import { Router } from 'express';
import { CUSTOM_ALIAS_PATTERN } from '../links/alias.js';
import type { LinkService } from '../links/service.js';
import { renderHomePage, type CreatedLinkView } from '../ui/pages.js';
import { buildShortUrl } from './shared.js';

export type PagesRouterOptions = {
  service: LinkService;
  baseUrl: string;
  abuseContactEmail?: string | undefined;
};

function firstQueryValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createPagesRouter({
  service,
  baseUrl,
  abuseContactEmail,
}: PagesRouterOptions): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const requestedAlias = firstQueryValue(req.query.created);
    let created: CreatedLinkView | null = null;

    if (requestedAlias && CUSTOM_ALIAS_PATTERN.test(requestedAlias)) {
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
      .send(renderHomePage({ created, abuseContactEmail }));
  });

  router.post('/links', async (req, res) => {
    const submittedUrl =
      typeof req.body?.url === 'string' ? req.body.url : '';
    const result = await service.create({ url: submittedUrl });

    if (!result.ok) {
      res
        .status(result.code === 'alias_taken' ? 409 : 422)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderHomePage({
            errorMessage: result.message,
            submittedUrl,
            abuseContactEmail,
          }),
        );
      return;
    }

    res.redirect(303, `/?created=${encodeURIComponent(result.link.alias)}`);
  });

  return router;
}
