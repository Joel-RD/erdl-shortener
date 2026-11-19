import type { ErrorRequestHandler, RequestHandler } from 'express';
import { renderErrorPage } from '../../ui/pages/error.js';
import { wantsHtml } from '../negotiation.js';

export type ErrorHandlerOptions = {
  abuseContactEmail?: string | undefined;
};

export function createNotFoundHandler({
  abuseContactEmail,
}: ErrorHandlerOptions): RequestHandler {
  return (req, res) => {
    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(404)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status: 404,
            title: 'Página no encontrada',
            message: 'La ruta que buscas no existe en este servidor.',
            abuseContactEmail,
          }),
        );
      return;
    }

    res.status(404).json({ error: 'not_found' });
  };
}

export function createErrorHandler({
  abuseContactEmail,
}: ErrorHandlerOptions): ErrorRequestHandler {
  return (err, req, res, next) => {
    const rawStatus =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : Number.NaN;

    const status =
      Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500
        ? rawStatus
        : 500;

    if (status >= 500) {
      req.log.error({ err }, 'unhandled_error');
    } else {
      // Un 4xx suele venir de un parser o de un middleware de Express con
      // `body`/`raw` adjuntos. Loguear solo el contrato evita filtrar el
      // cuerpo (posibles secretos) y mantiene la línea pequeña.
      const type =
        typeof err === 'object' && err !== null && 'type' in err
          ? String((err as { type?: unknown }).type)
          : 'unknown';
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message).slice(0, 200)
          : 'unknown';

      req.log.warn({ type, status, message }, 'request_error');
    }

    if (res.headersSent) {
      next(err);
      return;
    }

    res.set('Cache-Control', 'no-store');

    if (wantsHtml(req) && !req.path.startsWith('/api/')) {
      res
        .status(status)
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(
          renderErrorPage({
            status,
            title: status === 500 ? 'Algo salió mal' : 'Petición no válida',
            message:
              status === 500
                ? 'Tuvimos un problema al procesar la petición. Inténtalo de nuevo.'
                : 'La petición no se pudo procesar tal como llegó.',
            abuseContactEmail,
          }),
        );
      return;
    }

    const errorCode =
      status === 413
        ? 'payload_too_large'
        : status === 415
          ? 'unsupported_media_type'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : status === 400
                ? 'bad_request'
                : status >= 500
                  ? 'internal_error'
                  : 'bad_request';

    res.status(status).json({ error: errorCode });
  };
}
