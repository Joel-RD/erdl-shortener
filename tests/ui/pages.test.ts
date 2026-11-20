import { describe, expect, it } from 'vitest';
import { getHomeFormLimits } from '../../src/http/presenters/home-form.js';
import { escapeHtml } from '../../src/ui/escape-html.js';
import { renderHomePage } from '../../src/ui/pages/home.js';

const LIMITS = getHomeFormLimits();

describe('escapeHtml', () => {
  it('escapa los cinco caracteres peligrosos de HTML', () => {
    expect(escapeHtml(`& < > " '`)).toBe(
      '&amp; &lt; &gt; &quot; &#39;',
    );
  });

  it('no vuelve a escapar entidades ya producidas', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderHomePage', () => {
  it('escapa el alias, la URL y el mensaje de error', () => {
    const html = renderHomePage({
      limits: LIMITS,
      created: {
        alias: 'alias',
        shortUrl: 'https://short.test/"><script>alert(1)</script>',
        url: 'https://example.com/"><script>alert(2)</script>',
        clicks: 0,
        createdAt: '2026-11-13T00:00:00.000Z',
        expiresAt: null,
      },
      errorMessage: '<img src=x onerror=alert(3)>',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(3)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(3)&gt;');
  });

  it('solo carga el script externo permitido por la CSP', () => {
    const html = renderHomePage({ limits: LIMITS });
    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];

    expect(scriptTags).toEqual(['<script src="/app.js" defer>']);
    expect(html).not.toContain('onclick=');
  });

  it('deriva los atributos del formulario de los límites recibidos', () => {
    const html = renderHomePage({
      limits: {
        ...LIMITS,
        urlMaxLength: 1234,
        aliasMinLength: 4,
        aliasMaxLength: 12,
        aliasPattern: '[a-z]{4,12}',
        expirationMinLabel: '10 minutos',
        expirationMaxLabel: '2 días',
      },
    });

    expect(html).toContain('maxlength="1234"');
    expect(html).toContain('pattern="[a-z]{4,12}"');
    expect(html).toContain('minlength="4"');
    expect(html).toContain('maxlength="12"');
    expect(html).toContain('de 10 minutos a 2 días');
  });
});
