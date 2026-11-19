const MIN_EXPIRATION_MS = 5 * 60 * 1000;
const MAX_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;

export type ExpirationValidation =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/** Normaliza la caducidad pedida y la acota al rango permitido. */
export function validateExpiration(
  expiresAt: Date | null | undefined,
  current: Date,
): ExpirationValidation {
  if (expiresAt === null || expiresAt === undefined) {
    return { ok: true, value: null };
  }

  const timestamp = expiresAt.getTime();

  if (!Number.isFinite(timestamp)) {
    return { ok: false, message: 'La fecha de expiración no es válida.' };
  }

  const currentMs = current.getTime();

  if (timestamp < currentMs + MIN_EXPIRATION_MS) {
    return {
      ok: false,
      message: 'La expiración debe ser al menos 5 minutos posterior a ahora.',
    };
  }

  if (timestamp > currentMs + MAX_EXPIRATION_MS) {
    return {
      ok: false,
      message: 'La expiración no puede superar un año desde ahora.',
    };
  }

  return { ok: true, value: expiresAt.toISOString() };
}
