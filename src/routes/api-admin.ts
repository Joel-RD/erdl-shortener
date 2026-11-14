import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../abuse/admin-auth.js';
import {
  normalizeBlocklistDomain,
  type Blocklist,
} from '../abuse/blocklist.js';
import type { LinkService } from '../links/service.js';

/**
 * Rutas de administración. Todas exigen `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * - `DELETE /api/v1/links/:alias`: takedown idempotente. Deshabilita la fila
 *   (no la borra) e invalida la caché del redirect.
 * - `POST /api/v1/admin/blocklist`: alta/actualización manual de un dominio.
 */

const blocklistSchema = z
  .object({
    domain: z.string().trim().min(1).max(2048),
    enabled: z.boolean().default(true),
  })
  .strict();

export type AdminRouterOptions = {
  service: LinkService;
  blocklist: Blocklist;
  adminToken: string;
};

export function createAdminRouter({
  service,
  blocklist,
  adminToken,
}: AdminRouterOptions): Router {
  const router = Router();
  const auth = requireAdminToken(adminToken);

  router.delete('/links/:alias', auth, async (req, res) => {
    const aliasParam = req.params.alias;
    const alias = Array.isArray(aliasParam)
      ? (aliasParam[0] ?? '')
      : (aliasParam ?? '');
    const result = await service.disable(alias);

    if (!result.ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.status(204).end();
  });

  router.post('/admin/blocklist', auth, async (req, res) => {
    const parsed = blocklistSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'El cuerpo debe incluir un dominio válido.',
      });
      return;
    }

    const domain = normalizeBlocklistDomain(parsed.data.domain);

    if (domain === null) {
      res.status(400).json({
        error: 'invalid_domain',
        message: 'Indica un dominio registrable, por ejemplo example.com.',
      });
      return;
    }

    const added = await blocklist.addManual(domain, parsed.data.enabled);

    res.status(201).json({
      domain: added.domain,
      source: 'manual',
      enabled: added.enabled,
    });
  });

  return router;
}
