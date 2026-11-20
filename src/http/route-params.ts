import type { Request } from 'express';

/**
 * Primer valor de un parámetro de ruta, siempre como string.
 *
 * Express 5 tipa `req.params` como string, pero en tiempo de ejecución algunos
 * routers pueden entregar arrays. Centralizar la lectura evita que cada ruta
 * decida por su cuenta cómo tratar ese caso.
 */
export function getRouteParam(req: Request, name: string): string {
  const value: unknown = req.params[name];

  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : '';
  }

  return '';
}
