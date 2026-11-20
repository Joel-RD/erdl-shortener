import { escapeHtml } from '../escape-html.js';
import { renderDocument, type PageChrome } from '../layout.js';

export type CreatedLinkView = {
  alias: string;
  shortUrl: string;
  url: string;
  clicks: number;
  createdAt: string;
  expiresAt: string | null;
};

/**
 * Límites que la página muestra en `maxlength`, `pattern`, `min` y en el
 * texto de ayuda. Vienen del dominio a través de `http/` para que el HTML no
 * mantenga una copia propia de las reglas.
 */
export type HomeFormLimits = {
  urlMaxLength: number;
  aliasMinLength: number;
  aliasMaxLength: number;
  aliasPattern: string;
  expirationMinLabel: string;
  expirationMaxLabel: string;
};

export type HomePageInput = PageChrome & {
  limits: HomeFormLimits;
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

const NUMBER_FORMAT = new Intl.NumberFormat('es-ES');

export function renderHomePage({
  limits,
  created = null,
  errorMessage = null,
  submittedUrl = '',
  submittedAlias = '',
  submittedExpiresAt = '',
  formToken = '',
  minExpiration = '',
  abuseContactEmail,
}: HomePageInput): string {
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
              maxlength="${limits.urlMaxLength}"
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
                pattern="${escapeHtml(limits.aliasPattern)}"
                minlength="${limits.aliasMinLength}"
                maxlength="${limits.aliasMaxLength}"
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
            Solo http y https · máximo ${NUMBER_FORMAT.format(limits.urlMaxLength)} caracteres.
            El alias admite ${limits.aliasMinLength}–${limits.aliasMaxLength} letras, números, guion o guion bajo.
            La caducidad va de ${limits.expirationMinLabel} a ${limits.expirationMaxLabel}.
          </p>
        </form>
        <p class="privacy">
          No pedimos correo ni contraseña. La IP se usa solo para límites de
          abuso y se guarda como hash temporal.
          <a href="/privacidad">Cómo tratamos tus datos</a>
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
