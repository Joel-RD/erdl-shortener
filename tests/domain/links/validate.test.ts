import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH, validateUrl, type UrlErrorCode } from '../../../src/domain/links/validate.js';

function expectValid(raw: string) {
  const result = validateUrl(raw);

  if (!result.ok) {
    throw new Error(`Se esperaba válida, pero falló con ${result.code}`);
  }

  return result.value;
}

describe('validateUrl', () => {
  it('normaliza host, mayúsculas y punto final', () => {
    const value = expectValid('HTTPS://Example.COM./Ruta?q=1');

    expect(value.url).toBe('https://example.com/Ruta?q=1');
    expect(value.host).toBe('example.com');
    expect(value.domain).toBe('example.com');
  });

  it('extrae el dominio registrable de subdominios', () => {
    const value = expectValid('https://a.b.example.co.uk/path');

    expect(value.domain).toBe('example.co.uk');
  });

  it('convierte un dominio Unicode a punycode', () => {
    const value = expectValid('https://münich.example/ruta');

    expect(value.host).toBe('xn--mnich-kva.example');
    expect(value.url).toBe('https://xn--mnich-kva.example/ruta');
  });

  it('acepta una IPv6 pública', () => {
    const value = expectValid('https://[2001:4860:4860::8888]/dns');

    expect(value.url).toBe('https://[2001:4860:4860::8888]/dns');
  });

  it('conserva query y fragmento', () => {
    const value = expectValid('https://example.com/a?x=1&y=2#seccion');

    expect(value.url).toBe('https://example.com/a?x=1&y=2#seccion');
  });

  const rejected: Array<[string, UrlErrorCode]> = [
    ['', 'url_required'],
    ['   ', 'url_required'],
    ['no es una url', 'url_invalid'],
    ['javascript:alert(1)', 'url_scheme'],
    ['ftp://example.com/archivo', 'url_scheme'],
    ['http://user:password@example.com/', 'url_credentials'],
    ['http://localhost:3000/', 'url_local'],
    ['http://foo.localhost/', 'url_local'],
    ['http://intranet/', 'url_local'],
    ['http://impresora.local/', 'url_local'],
    ['http://home.arpa/', 'url_local'],
    ['http://router.home.arpa/', 'url_local'],
    ['http://servidor.lan/', 'url_local'],
    ['http://nas.corp/', 'url_local'],
    ['http://127.0.0.1/', 'url_private_ip'],
    ['http://127.1/', 'url_private_ip'],
    ['http://2130706433/', 'url_private_ip'],
    ['http://0x7f.1/', 'url_private_ip'],
    ['http://10.0.0.1/', 'url_private_ip'],
    ['http://172.16.0.1/', 'url_private_ip'],
    ['http://192.168.1.1/', 'url_private_ip'],
    ['http://169.254.169.254/latest/meta-data/', 'url_private_ip'],
    ['http://100.64.0.1/', 'url_private_ip'],
    ['http://0.0.0.0/', 'url_private_ip'],
    ['http://[::1]/', 'url_private_ip'],
    ['http://[fd00::1]/', 'url_private_ip'],
    ['http://[fe80::1]/', 'url_private_ip'],
    ['http://[::ffff:127.0.0.1]/', 'url_private_ip'],
    ['http://[64:ff9b::7f00:1]/', 'url_private_ip'],
    ['http://[2001:0:1::1]/', 'url_private_ip'],
    ['http://[fec0::1]/', 'url_private_ip'],
    ['http://[100::1]/', 'url_private_ip'],
    ['http://[64:ff9b:1::1]/', 'url_private_ip'],
    ['http://[::ffff:0:7f00:1]/', 'url_private_ip'],
    [`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`, 'url_too_long'],
  ];

  it.each(rejected)('rechaza %s con %s', (raw, code) => {
    const result = validateUrl(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
