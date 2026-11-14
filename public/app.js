/**
 * Mejora progresiva del botón de copiar.
 *
 * Vive en un archivo externo (no inline) para cumplir la CSP estricta:
 * `script-src 'self'`.
 */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Puede fallar por permisos; probamos el método clásico.
    }
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.className = 'clipboard-helper';
  document.body.appendChild(helper);

  try {
    helper.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    helper.remove();
  }
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy');
    if (!text) return;

    const result = button.closest('.result');
    const status = result?.querySelector('.copy-status');
    const originalLabel = button.textContent;
    const copied = await copyText(text);

    if (!copied) {
      if (status) {
        status.textContent =
          'No se pudo copiar. Selecciona el enlace manualmente.';
      }
      return;
    }

    button.textContent = 'Copiado';
    if (status) status.textContent = 'Enlace copiado al portapapeles.';

    window.setTimeout(() => {
      button.textContent = originalLabel;
      if (status) status.textContent = '';
    }, 2200);
  });
}
