import type { RequestHandler } from 'express';

/**
 * La API solo acepta JSON. Sin esto, un formulario urlencoded llegaría como
 * `{}` y el error sería un 400 confuso (o peor: un 201 con otro parser).
 */
export function requireJsonContentType(): RequestHandler {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      next();
      return;
    }

    const contentType = (req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();

    if (contentType !== 'application/json') {
      res.set('Cache-Control', 'no-store').status(415).json({
        error: 'unsupported_media_type',
        message: 'La API solo acepta application/json.',
      });
      return;
    }

    next();
  };
}
