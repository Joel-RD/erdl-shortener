/**
 * Parsers puros de direcciones IP.
 *
 * Capa neutra compartida por `domain/` (detección de destinos internos) y
 * `security/` (normalización de IPs para límites). No toca red, DNS ni el
 * sistema de archivos; solo interpreta representaciones textuales.
 */

/** Convierte una IPv4 decimal en cuatro octetos; `null` si no es válida. */
export function parseIpv4Octets(value: string): number[] | null {
  const parts = value.split('.');

  if (parts.length !== 4) return null;

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;

    const octet = Number(part);

    if (octet < 0 || octet > 255) return null;

    octets.push(octet);
  }

  return octets;
}

/**
 * Expande una IPv6 a 8 grupos de 16 bits.
 *
 * Acepta `::`, zone id (`%eth0`) y una IPv4 embebida al final
 * (`::ffff:127.0.0.1`). Devuelve `null` para cualquier forma inválida.
 */
export function parseIpv6Groups(value: string): number[] | null {
  const withoutZone = value.split('%')[0] ?? '';

  if (withoutZone === '') return null;
  if (withoutZone.includes('::') && withoutZone.split('::').length > 2) {
    return null;
  }

  const [headRaw = '', tailRaw = ''] = withoutZone.split('::');
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === '' ? [] : tailRaw.split(':');

  const parseGroups = (parts: string[]): number[] | null => {
    const groups: number[] = [];

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';

      if (part.includes('.')) {
        // La IPv4 embebida solo es válida como último grupo de esa mitad.
        if (index !== parts.length - 1) return null;

        const octets = parseIpv4Octets(part);
        if (!octets) return null;

        groups.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }

    return groups;
  };

  const preparedHead = parseGroups(head);
  const preparedTail = parseGroups(tail);

  if (!preparedHead || !preparedTail) return null;

  const compressed = withoutZone.includes('::');
  const missing = 8 - preparedHead.length - preparedTail.length;

  if (compressed ? missing < 1 : missing !== 0) return null;

  const groups = [
    ...preparedHead,
    ...Array<number>(compressed ? missing : 0).fill(0),
    ...preparedTail,
  ];

  return groups.length === 8 ? groups : null;
}

/** Pasa los 8 grupos de una IPv6 a sus 16 bytes, de mayor a menor peso. */
export function ipv6GroupsToBytes(groups: readonly number[]): number[] {
  const bytes: number[] = [];

  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }

  return bytes;
}
