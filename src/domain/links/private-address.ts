import {
  ipv6GroupsToBytes,
  parseIpv4Octets,
  parseIpv6Groups,
} from '../../net/ip.js';

/**
 * Detección de direcciones IP privadas, reservadas o no enrutables.
 *
 * Se usa al validar la URL de destino para bloquear destinos internos
 * (SSRF). No toca red ni DNS: solo interpreta la representación textual.
 */

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  return (
    a === 0 || // "esta red"
    a === 10 || // privada
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (incluye metadata cloud)
    (a === 172 && b >= 16 && b <= 31) || // privada
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentación
    (a === 192 && b === 88 && c === 99) || // relay 6to4
    (a === 192 && b === 168) || // privada
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentación
    (a === 203 && b === 0 && c === 113) || // documentación
    a >= 224 // multicast, reservada y broadcast
  );
}

function startsWithBytes(
  bytes: readonly number[],
  prefix: readonly number[],
): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function isPrivateIpv6(bytes: readonly number[]): boolean {
  if (bytes.length !== 16) return false;

  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) &&
    bytes[15] === 1;

  if (allZero || loopback) return true;

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const uniqueLocal = (first & 0xfe) === 0xfc;
  const linkLocal = first === 0xfe && (second & 0xc0) === 0x80;
  // Site-local (fec0::/10) está obsoleto, pero sigue siendo una dirección
  // interna y no debe usarse como destino público.
  const siteLocal = first === 0xfe && (second & 0xc0) === 0xc0;
  const multicast = first === 0xff;
  const documentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;

  // Teredo (2001::/32) y discard-only (100::/64) no son destinos legítimos.
  const teredo = startsWithBytes(bytes, [0x20, 0x01, 0x00, 0x00]);
  const discardOnly = startsWithBytes(bytes, [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);

  if (
    uniqueLocal ||
    linkLocal ||
    siteLocal ||
    multicast ||
    documentation ||
    teredo ||
    discardOnly
  ) {
    return true;
  }

  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  const ipv4Mapped =
    firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;

  if (ipv4Mapped) {
    return isPrivateIpv4(bytes.slice(12));
  }

  // IPv4-translated (::ffff:0:0/96): primeros 8 bytes a cero, `ffff` y dos
  // ceros, con la IPv4 en los últimos 4 bytes.
  const ipv4Translated =
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0x00 &&
    bytes[11] === 0x00;

  if (ipv4Translated) {
    return isPrivateIpv4(bytes.slice(12));
  }

  // IPv4-compatible (::a.b.c.d), formato antiguo pero todavía interpretable.
  const firstTwelveZero = bytes.slice(0, 12).every((byte) => byte === 0);
  if (firstTwelveZero) return isPrivateIpv4(bytes.slice(12));

  // 6to4 (2002::/16) lleva una IPv4 embebida en los bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(bytes.slice(2, 6));
  }

  // NAT64 well-known prefix (64:ff9b::/96) lleva la IPv4 al final.
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);

  if (nat64) return isPrivateIpv4(bytes.slice(12));

  // NAT64 de uso local (64:ff9b:1::/48) tampoco es un destino público.
  if (startsWithBytes(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) {
    return true;
  }

  return false;
}

export function isPrivateAddress(host: string): boolean {
  const ipv4 = parseIpv4Octets(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  const ipv6 = parseIpv6Groups(host);
  if (ipv6) return isPrivateIpv6(ipv6GroupsToBytes(ipv6));

  return false;
}
