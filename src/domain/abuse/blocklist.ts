import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';

/**
 * Reglas de la blocklist de dominios.
 *
 * La comparación es por dominio registrable: bloquear `example.co.uk` bloquea
 * también `a.b.example.co.uk`, pero no `notexample.co.uk`. Este módulo no toca
 * la DB ni el disco: la carga de la semilla y de las altas manuales vive en
 * `infra/db/blocklist-store.ts`.
 */

export type BlocklistAddResult = {
  domain: string;
  enabled: boolean;
};

export type Blocklist = {
  isBlocked(domain: string): Promise<boolean>;
  /** Alta o actualización manual; invalida la caché al terminar. */
  addManual(domain: string, enabled?: boolean): Promise<BlocklistAddResult>;
  invalidate(): void;
};

/**
 * Convierte una entrada escrita por una persona en un dominio registrable en
 * ASCII y minúsculas. Acepta un dominio suelto o una URL completa.
 *
 * Devuelve `null` para IPs (la validación de URL ya las controla) y para
 * entradas sin dominio público reconocible.
 */
export function normalizeBlocklistDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();

  if (value === '') return null;

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }

  value = value
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  // Acepta también `ejemplo.com/ruta` y `ejemplo.com:8080` sin exigir esquema.
  value = (value.split('/')[0] ?? '').replace(/:\d+$/, '').replace(/^.*@/, '');

  if (value === '' || value.length > 253) return null;

  const host = value.replace(/^\[|\]$/g, '');

  // Las IP no tienen dominio registrable; el validador de URLs ya rechaza las
  // privadas y aquí no queremos bloquear rangos públicos enteros por accidente.
  if (isIP(host)) return null;

  const ascii = domainToASCII(host);

  if (ascii === '' || !ascii.includes('.')) return null;

  // `getDomain` devuelve null para un sufijo público (`com`, `co.uk`): darlo
  // de alta bloquearía medio Internet. Los dominios privados (`github.io`)
  // siguen siendo válidos con `allowPrivateDomains: false`.
  const registrable = getDomain(ascii, { allowPrivateDomains: false });

  return registrable === null ? null : registrable.toLowerCase();
}

/**
 * Comprueba si un dominio coincide con alguna entrada. Recorre los sufijos
 * para que `sub.example.com` quede cubierto por `example.com`.
 */
export function matchesBlockedDomain(
  domain: string,
  blockedDomains: ReadonlySet<string>,
): boolean {
  const normalized = normalizeBlocklistDomain(domain);

  if (normalized === null) return false;

  const labels = normalized.split('.');

  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');

    if (blockedDomains.has(candidate)) return true;
  }

  return false;
}
