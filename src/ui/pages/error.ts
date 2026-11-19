import { escapeHtml } from '../escape-html.js';
import { renderDocument, type PageChrome } from '../layout.js';

export type ErrorPageInput = PageChrome & {
  status: number;
  title: string;
  message: string;
};

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
