import { describe, expect, it } from 'vitest';
import { escapeHtml } from './render.js';
import { renderHomePage } from './pages.js';

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
    const html = renderHomePage();
    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];

    expect(scriptTags).toEqual(['<script src="/app.js" defer>']);
    expect(html).not.toContain('onclick=');
  });
});
