import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Autenticación del administrador.
 *
 * Se hashean los dos tokens antes de compararlos porque `timingSafeEqual`
 * exige buffers de la misma longitud: hashear primero convierte cualquier
 * entrada (vacía, larga, distinta) en 32 bytes y evita filtrar por tiempo si
 * el token recibido se parece al esperado. El token viaja en
 * `Authorization: Bearer <token>` y nunca se registra en logs (pino lo redacta).
 */

export function verifyAdminToken(
  expected: string,
  received: string,
): boolean {
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  const receivedHash = createHash('sha256').update(received, 'utf8').digest();

  return timingSafeEqual(expectedHash, receivedHash);
}

export function readBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  return token ? token : null;
}

export function requireAdminToken(expected: string): RequestHandler {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');

    const received = readBearerToken(req.headers.authorization);

    if (received === null || !verifyAdminToken(expected, received)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({
        error: 'unauthorized',
        message: 'Token de administración inválido o ausente.',
      });
      return;
    }

    next();
  };
}
