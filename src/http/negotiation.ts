import type { Request } from 'express';

/**
 * Negociación mínima: un navegador manda `text/html`; curl y los clientes de
 * API no. Así `GET /:alias` puede devolver una página bonita o JSON sin
 * duplicar rutas.
 */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}
