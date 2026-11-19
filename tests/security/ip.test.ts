import { describe, expect, it } from 'vitest';
import {
  getClientIp,
  hashIp,
  ipKey,
  normalizeClientIp,
} from '../../src/security/ip.js';

describe('normalizeClientIp', () => {
  it('convierte IPv4-mapped y quita el zone id de IPv6', () => {
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('2001:DB8:0:0:0:0:0:1')).toBe(
      '2001:db8:0:0:0:0:0:1',
    );
    expect(normalizeClientIp('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1');
  });

  it('usa un valor estable para una IP ausente', () => {
    expect(normalizeClientIp(undefined)).toBe('unknown');
    expect(normalizeClientIp('   ')).toBe('unknown');
  });
});

describe('ipKey', () => {
  it('agrupa direcciones del mismo /64 IPv6', () => {
    const first = ipKey('2001:db8:abcd:12:aaaa::1');
    const second = ipKey('2001:db8:abcd:12:bbbb::2');

    expect(first).toBe('2001:0db8:abcd:0012::/64');
    expect(second).toBe(first);
  });

  it('separa prefijos /64 distintos y conserva IPv4', () => {
    expect(ipKey('2001:db8:abcd:12::1')).not.toBe(
      ipKey('2001:db8:abcd:13::1'),
    );
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('hashIp', () => {
  it('produce un HMAC-SHA256 hexadecimal determinista', () => {
    const secret = 'secreto-de-prueba-0123456789';
    const first = hashIp(secret, '203.0.113.7');
    const second = hashIp(secret, '203.0.113.7');

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(second);
    expect(hashIp(secret, '203.0.113.8')).not.toBe(first);
  });

  it('cambia por completo si cambia el secreto', () => {
    expect(hashIp('secreto-a-0123456789', '203.0.113.7')).not.toBe(
      hashIp('secreto-b-0123456789', '203.0.113.7'),
    );
  });
});

describe('getClientIp', () => {
  it('prefiere req.ip y cae al socket', () => {
    expect(getClientIp({ ip: '198.51.100.1' })).toBe('198.51.100.1');
    expect(
      getClientIp({ socket: { remoteAddress: '198.51.100.2' } }),
    ).toBe('198.51.100.2');
    expect(getClientIp({})).toBe('unknown');
  });
});
