import { Router } from 'express';
import { z } from 'zod';
import {
  type CreateLinkErrorCode,
  type CreateLinkInput,
  type LinkService,
} from '../links/service.js';
import { toLinkResponse } from './shared.js';

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
  expiration_invalid: 400,
};

export type ApiLinksRouterOptions = {
  service: LinkService;
  baseUrl: string;
};

export function createApiLinksRouter({
  service,
  baseUrl,
}: ApiLinksRouterOptions): Router {
  const router = Router();

  router.post('/links', async (req, res) => {
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

    const input: CreateLinkInput = { url: parsed.data.url };

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
    const alias = req.params.alias ?? '';
    const result = await service.getMetadata(alias);

    res.set('Cache-Control', 'no-store');

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
