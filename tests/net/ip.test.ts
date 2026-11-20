import { describe, expect, it } from 'vitest';
import {
  ipv6GroupsToBytes,
  parseIpv4Octets,
  parseIpv6Groups,
} from '../../src/net/ip.js';

describe('parseIpv4Octets', () => {
  it('acepta cuatro octetos decimales dentro de rango', () => {
    expect(parseIpv4Octets('203.0.113.7')).toEqual([203, 0, 113, 7]);
    expect(parseIpv4Octets('0.0.0.0')).toEqual([0, 0, 0, 0]);
  });

  it('rechaza formas ambiguas o fuera de rango', () => {
    expect(parseIpv4Octets('203.0.113')).toBeNull();
    expect(parseIpv4Octets('203.0.113.256')).toBeNull();
    expect(parseIpv4Octets('203.0.113.-1')).toBeNull();
    expect(parseIpv4Octets('203.0.0x11.7')).toBeNull();
    expect(parseIpv4Octets('1..2.3')).toBeNull();
  });
});

describe('parseIpv6Groups', () => {
  it('expande la compresión y normaliza mayúsculas', () => {
    expect(parseIpv6Groups('2001:DB8:0:0:0:0:0:1')).toEqual([
      0x2001, 0x0db8, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6Groups('fe80::1%eth0')).toEqual([
      0xfe80, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('acepta una IPv4 embebida al final', () => {
    expect(parseIpv6Groups('::ffff:127.0.0.1')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001,
    ]);
  });

  it('rechaza formas inválidas', () => {
    expect(parseIpv6Groups('')).toBeNull();
    expect(parseIpv6Groups('1::2::3')).toBeNull();
    expect(parseIpv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6Groups('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIpv6Groups('gggg::1')).toBeNull();
  });
});

describe('ipv6GroupsToBytes', () => {
  it('produce 16 bytes en orden de red', () => {
    const bytes = ipv6GroupsToBytes([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);

    expect(bytes).toHaveLength(16);
    expect(bytes.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(bytes.slice(14)).toEqual([0x00, 0x01]);
  });
});
