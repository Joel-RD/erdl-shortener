import type { Request } from 'express';
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
