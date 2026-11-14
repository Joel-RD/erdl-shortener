/**
 * Escape de HTML para SSR.
 *
 * Todo dato que venga de la URL, del alias o de la base de datos se interpola
 * con esta función. Un alias o un destino malicioso nunca debe convertirse en
 * etiquetas ejecutables.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}
