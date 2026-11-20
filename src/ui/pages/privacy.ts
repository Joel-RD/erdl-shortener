import { escapeHtml } from '../escape-html.js';
import { renderDocument, type PageChrome } from '../layout.js';

export type PrivacyPageInput = PageChrome & {
  /** Días configurados en IP_RETENTION_DAYS antes de anonimizar el hash. */
  retentionDays: number;
};

/**
 * Política de privacidad pública. Se sirve desde SSR, sin plantillas externas
 * ni scripts propios: el único JS del sitio sigue siendo el botón de copiar.
 */
export function renderPrivacyPage({
  retentionDays,
  abuseContactEmail,
}: PrivacyPageInput): string {
  const abuse = abuseContactEmail
    ? `escribe a <a href="mailto:${escapeHtml(abuseContactEmail)}">${escapeHtml(abuseContactEmail)}</a>`
    : 'usa el correo de contacto indicado en el pie de esta página';
  const days = escapeHtml(String(retentionDays));

  const body = `
    <main class="layout layout-legal">
      <section class="hero" aria-labelledby="privacy-title">
        <p class="eyebrow">Privacidad · alpha pública</p>
        <h1 id="privacy-title">Qué guardamos<br><em>y por cuánto tiempo.</em></h1>
        <p class="lede">
          erdl no tiene cuentas ni cookies de seguimiento. Guardamos lo mínimo
          para crear enlaces, contar clics y frenar abusos.
        </p>
        <p><a class="button button-primary" href="/">Crear un enlace</a></p>
      </section>

      <article class="panel panel-note legal" aria-labelledby="legal-title">
        <h2 id="legal-title">Datos que se almacenan</h2>
        <ul>
          <li><strong>Enlace:</strong> la URL de destino normalizada (solo http y https), el alias y la fecha de creación.</li>
          <li><strong>Ciclo de vida:</strong> la caducidad opcional, la fecha de retirado y su motivo, si un administrador deshabilita el enlace.</li>
          <li><strong>Uso:</strong> el número de clics y la fecha del último clic.</li>
          <li><strong>Señal de abuso:</strong> un HMAC-SHA256 de tu IP (IPv4 completa o prefijo /64 de IPv6) calculado con un secreto del servidor. La IP en claro no se guarda en la base de datos.</li>
        </ul>

        <h2>Para qué se usan</h2>
        <p>
          El destino y el alias son necesarios para redirigir. El hash de IP
          sirve para aplicar límites de creación y lectura, la cuota de enlaces
          activos y el dedupe. Los clics son un contador agregado, no un
          historial de visitantes.
        </p>

        <h2>Retención</h2>
        <p>
          El hash de IP se anonimiza a los ${days} días: se pone a nulo y deja
          de contar para cuotas y dedupe. El operador puede configurar ese
          plazo entre 30 y 90 días. Los enlaces no se borran automáticamente al
          caducar: siguen respondiendo 410 y su alias queda reservado.
        </p>

        <h2>Cookies y terceros</h2>
        <p>
          No usamos cookies de seguimiento, analítica de terceros ni redes
          publicitarias. El único JavaScript es el botón de copiar y se sirve
          desde este mismo dominio. Los proveedores de infraestructura
          (Render y Turso/libSQL) tratan los datos para operar el servicio.
        </p>

        <h2>Reportes y retirada</h2>
        <p>
          Para reportar abuso o pedir el retirado de un enlace, ${abuse}.
          El operador revisa el caso y puede deshabilitar el enlace. Al ser un
          servicio anónimo no podemos verificar quién creó un enlace.
        </p>

        <h2>Seguridad y cambios</h2>
        <p>
          Los logs de la aplicación no incluyen tu IP, cabeceras de proxy ni
          tokens; las respuestas usan CSP estricta y los secretos se comparan
          en tiempo constante. Los cambios de esta política se registrarán en
          el repositorio y en <code>CHANGELOG.md</code>.
        </p>
      </article>
    </main>
  `;

  return renderDocument({
    title: 'Privacidad · erdl',
    body,
    abuseContactEmail,
  });
}
