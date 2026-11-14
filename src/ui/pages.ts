import { escapeHtml } from './render.js';

/**
 * Páginas SSR. Cada función devuelve HTML completo; no hay plantilla externa ni
 * scripts inline, para que la CSP pueda ser estricta.
 */

export type PageChrome = {
  abuseContactEmail?: string | undefined;
};

export type CreatedLinkView = {
  alias: string;
  shortUrl: string;
  url: string;
  clicks: number;
  createdAt: string;
  expiresAt: string | null;
};

export type HomePageInput = PageChrome & {
  created?: CreatedLinkView | null;
  errorMessage?: string | null;
  submittedUrl?: string;
  submittedAlias?: string;
  submittedExpiresAt?: string;
  /** Token HMAC del honeypot; el formulario no funciona sin él. */
  formToken?: string;
  /** Mínimo del input datetime-local, en UTC (`YYYY-MM-DDTHH:mm`). */
  minExpiration?: string;
};

export type ErrorPageInput = PageChrome & {
  status: number;
  title: string;
  message: string;
};

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${day} ${month} ${year} · ${hours}:${minutes} UTC`;
}

function formatClicks(clicks: number): string {
  return `${clicks} ${clicks === 1 ? 'clic' : 'clics'}`;
}

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

function renderDocument({
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

function renderCreatedCard(created: CreatedLinkView): string {
  const displayUrl = created.shortUrl.replace(/^https?:\/\//, '');
  const expiry = created.expiresAt
    ? `<div>
        <dt>Caduca</dt>
        <dd>${escapeHtml(formatDate(created.expiresAt))}</dd>
      </div>`
    : '';

  return `
    <article class="result" aria-labelledby="result-title">
      <div class="result-top">
        <p class="eyebrow" id="result-title">Enlace listo</p>
        <span class="live-dot" aria-hidden="true"></span>
      </div>
      <a class="short-url" href="${escapeHtml(created.shortUrl)}">${escapeHtml(displayUrl)}</a>
      <div class="result-actions">
        <button class="button button-copy" type="button" data-copy="${escapeHtml(created.shortUrl)}">
          Copiar enlace
        </button>
        <a class="button button-ghost" href="${escapeHtml(created.shortUrl)}" rel="noreferrer">
          Abrir
        </a>
      </div>
      <dl class="result-meta">
        <div>
          <dt>Destino</dt>
          <dd class="destination">${escapeHtml(created.url)}</dd>
        </div>
        <div>
          <dt>Clics</dt>
          <dd>${escapeHtml(formatClicks(created.clicks))}</dd>
        </div>
        <div>
          <dt>Creado</dt>
          <dd>${escapeHtml(formatDate(created.createdAt))}</dd>
        </div>
        ${expiry}
      </dl>
      <p class="copy-status" role="status" aria-live="polite"></p>
    </article>
  `;
}

export function renderHomePage({
  created = null,
  errorMessage = null,
  submittedUrl = '',
  submittedAlias = '',
  submittedExpiresAt = '',
  formToken = '',
  minExpiration = '',
  abuseContactEmail,
}: HomePageInput = {}): string {
  const hasCreated = created !== null;
  const formTitle = hasCreated ? 'Acorta otro enlace' : 'Crea tu enlace';

  const body = `
    <main class="layout">
      <section class="hero" aria-labelledby="page-title">
        <p class="eyebrow">Sin registro · Sin panel</p>
        <h1 id="page-title">URLs largas,<br><em>enlaces cortos.</em></h1>
        <p class="lede">
          Pega una dirección y obtén un enlace que cabe en cualquier sitio.
          El destino se resuelve al instante con una redirección directa.
        </p>
        <ul class="principles">
          <li><span>01</span> Redirección 302 sin caché intermedia.</li>
          <li><span>02</span> Alias aleatorio o personalizado.</li>
          <li><span>03</span> Solo datos públicos, sin cuentas.</li>
        </ul>
      </section>

      <section class="panel" aria-labelledby="form-title">
        ${hasCreated ? renderCreatedCard(created) : ''}
        ${
          errorMessage
            ? `<div class="alert" id="url-error" role="alert">
                <strong>No se pudo crear el enlace.</strong>
                <span>${escapeHtml(errorMessage)}</span>
              </div>`
            : ''
        }
        <div class="form-head">
          <p class="eyebrow">Acortar URL</p>
          <h2 id="form-title">${formTitle}</h2>
        </div>
        <form class="shorten-form" method="post" action="/links">
          <input type="hidden" name="_formToken" value="${escapeHtml(formToken)}">
          <div class="hp-field" aria-hidden="true">
            <label for="website">No rellenar</label>
            <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
          </div>
          <label for="url">URL de destino</label>
          <div class="field-row">
            <input
              id="url"
              name="url"
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="https://ejemplo.com/una/ruta/muy/larga"
              maxlength="4096"
              required
              value="${escapeHtml(submittedUrl)}"
              ${errorMessage ? 'aria-invalid="true"' : ''}
              aria-describedby="${errorMessage ? 'url-error url-hint' : 'url-hint'}"
            >
            <button class="button button-primary" type="submit">Acortar</button>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="alias">Alias propio <span>opcional</span></label>
              <input
                id="alias"
                name="alias"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                pattern="[A-Za-z0-9_-]{3,32}"
                minlength="3"
                maxlength="32"
                placeholder="mi-enlace"
                value="${escapeHtml(submittedAlias)}"
              >
            </div>
            <div class="field">
              <label for="expiresAt">Caducidad <span>opcional, UTC</span></label>
              <input
                id="expiresAt"
                name="expiresAt"
                type="datetime-local"
                value="${escapeHtml(submittedExpiresAt)}"
                ${minExpiration ? `min="${escapeHtml(minExpiration)}"` : ''}
              >
            </div>
          </div>
          <p class="hint" id="url-hint">
            Solo http y https · máximo 4.096 caracteres.
            El alias admite 3–32 letras, números, guion o guion bajo.
            La caducidad va de 5 minutos a 1 año.
          </p>
        </form>
        <p class="privacy">
          No pedimos correo ni contraseña. La IP se usa solo para límites de
          abuso y se guarda como hash temporal.
        </p>
      </section>
    </main>
  `;

  return renderDocument({
    title: hasCreated ? 'Enlace creado · erdl' : 'erdl · Acortador de URLs',
    body,
    abuseContactEmail,
  });
}

export function renderErrorPage({
  status,
  title,
  message,
  abuseContactEmail,
}: ErrorPageInput): string {
  const body = `
    <main class="layout layout-error">
      <section class="hero" aria-labelledby="error-title">
        <p class="eyebrow">Error ${status}</p>
        <h1 id="error-title">${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(message)}</p>
        <a class="button button-primary" href="/">Crear un enlace</a>
      </section>
      <aside class="panel panel-note" aria-label="Qué puedes hacer">
        <p class="eyebrow">Siguiente paso</p>
        <h2>Vuelve al inicio</h2>
        <p>
          Si esperabas encontrar algo aquí, el enlace pudo caducar, haber sido
          retirado o no haber existido nunca.
        </p>
      </aside>
    </main>
  `;

  return renderDocument({
    title: `${title} · erdl`,
    body,
    noindex: true,
    abuseContactEmail,
  });
}
