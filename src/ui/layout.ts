import { escapeHtml } from './escape-html.js';

/**
 * Estructura común de las páginas SSR. Cada página devuelve HTML completo; no
 * hay plantilla externa ni scripts inline, para que la CSP sea estricta.
 */

export type PageChrome = {
  abuseContactEmail?: string | undefined;
};

function renderHeader(): string {
  return `
    <header class="site-header">
      <a class="brand" href="/" aria-label="erdl, inicio">
        <span class="brand-mark" aria-hidden="true">e/</span>
        <span class="brand-name">erdl</span>
      </a>
      <span class="tagline">acortador anónimo</span>
    </header>
  `;
}

function renderFooter({ abuseContactEmail }: PageChrome): string {
  const abuse = abuseContactEmail
    ? `<a href="mailto:${escapeHtml(abuseContactEmail)}">${escapeHtml(abuseContactEmail)}</a>`
    : '<span>contacta con el operador del servicio</span>';

  return `
    <footer class="site-footer">
      <p>Sin cuentas. Sin cookies de seguimiento. Los enlaces pueden caducar.</p>
      <p class="abuse">Abuso: ${abuse}</p>
    </footer>
  `;
}

export function renderDocument({
  title,
  body,
  noindex = false,
  abuseContactEmail,
}: {
  title: string;
  body: string;
  noindex?: boolean;
  abuseContactEmail?: string | undefined;
}): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Acortador de URLs anónimo: pega una URL y obtén un enlace corto.">
  ${noindex ? '<meta name="robots" content="noindex">' : ''}
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f1ea">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <div class="page">
    ${renderHeader()}
    ${body}
    ${renderFooter({ abuseContactEmail })}
  </div>
</body>
</html>`;
}
