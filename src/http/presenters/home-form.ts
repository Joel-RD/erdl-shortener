/** `YYYY-MM-DDTHH:mm` en UTC, el formato que entiende datetime-local. */
export function formatDatetimeLocalUtc(date: Date): string {
  return date.toISOString().slice(0, 16);
}

/**
 * Convierte el valor de `<input type="datetime-local">` en una fecha UTC.
 * El formulario dice «UTC» de forma explícita: sin zona horaria del cliente
 * no hay manera fiable de interpretar otra cosa.
 */
export function parseFormExpiration(
  raw: string,
): { ok: true; value: Date | null } | { ok: false } {
  const value = raw.trim();

  if (value === '') return { ok: true, value: null };

  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);

  if (match === null) return { ok: false };

  const minute = match[1] ?? '';
  const seconds = match[2] ?? '00';
  const date = new Date(`${minute}:${seconds}.000Z`);

  // `new Date` normaliza fechas imposibles (31 de febrero → marzo). Comparar
  // el ida y vuelta detecta esos casos y los rechaza.
  if (
    !Number.isFinite(date.getTime()) ||
    formatDatetimeLocalUtc(date) !== minute
  ) {
    return { ok: false };
  }

  return { ok: true, value: date };
}
