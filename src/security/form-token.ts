import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Honeypot firmado para el formulario SSR.
 *
 * El servidor incrusta un token `timestamp.firma` en un campo oculto. Un bot
 * que rellene el campo trampa o envíe el formulario demasiado rápido (sin
 * esperar a que la firma envejezca) se descarta antes de tocar la DB.
 *
 * La firma HMAC impide que el bot invente un timestamp antiguo: sin el secreto
 * no puede fabricar una firma válida.
 */

export const FORM_TOKEN_FIELD = '_formToken';
export const FORM_HONEYPOT_FIELD = 'website';

/** Un humano tarda al menos esto en pegar una URL y pulsar el botón. */
export const DEFAULT_FORM_MIN_AGE_MS = 3_000;

/** Un formulario abierto más de 30 min probablemente sea un replay. */
export const DEFAULT_FORM_MAX_AGE_MS = 30 * 60 * 1000;

export type FormTokenStatus =
  | 'valid'
  | 'missing'
  | 'malformed'
  | 'too_fast'
  | 'expired';

export type VerifyFormTokenOptions = {
  now?: Date | undefined;
  minAgeMs?: number | undefined;
  maxAgeMs?: number | undefined;
  /**
   * Contexto ligado al token (el HMAC de la IP). Impide que un token robado a
   * otra conexión se reutilice desde una IP distinta.
   */
  context?: string | undefined;
};

function sign(secret: string, timestamp: string, context: string): string {
  return createHmac('sha256', secret)
    // El prefijo de longitud evita ambigüedades si el contexto contiene `:`.
    .update(`form-token:v2:${context.length}:${context}:${timestamp}`)
    .digest('hex');
}

function signaturesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createFormToken(
  secret: string,
  at: Date = new Date(),
  context = '',
): string {
  const timestamp = String(at.getTime());

  return `${timestamp}.${sign(secret, timestamp, context)}`;
}

export function verifyFormToken(
  secret: string,
  raw: unknown,
  options: VerifyFormTokenOptions = {},
): FormTokenStatus {
  if (typeof raw !== 'string' || raw.trim() === '') return 'missing';

  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(raw.trim());

  if (match === null) return 'malformed';

  const timestamp = match[1] ?? '';
  const signature = match[2] ?? '';
  const context = options.context ?? '';

  if (!signaturesMatch(signature, sign(secret, timestamp, context))) {
    return 'malformed';
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const minAgeMs = options.minAgeMs ?? DEFAULT_FORM_MIN_AGE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_FORM_MAX_AGE_MS;
  const ageMs = nowMs - Number(timestamp);

  // Un timestamp futuro también cae aquí: no puede ser un formulario legítimo.
  if (ageMs < minAgeMs) return 'too_fast';

  if (ageMs > maxAgeMs) return 'expired';

  return 'valid';
}
