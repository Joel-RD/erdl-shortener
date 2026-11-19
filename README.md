# erdl · Acortador de URLs anónimo

MVP de acortador de URLs sin cuentas. Express 5 + TypeScript estricto + libSQL
(SQLite local o Turso) con SSR, límites por IP, blocklist, honeypot firmado,
takedown administrativo, expiración y retención de IPs.

La guía de construcción por fases está en
[`docs/plan-MVP-acortador-url.md`](./docs/plan-MVP-acortador-url.md).

## Estado: fases 0–9 completas

| Fase | Qué aporta |
| --- | --- |
| 0 | Esqueleto, configuración Zod, `/health` |
| 1 | Esquema, migraciones idempotentes, índices |
| 2 | Validación/normalización de URL y alias |
| 3 | Servicio de enlaces y API |
| 4 | SSR, estáticos, CSP estricta |
| 5 | Caché LRU, buffer de clics, apagado limpio |
| 6 | HMAC de IP, rate limiting, cuota y dedupe |
| 7 | Blocklist, honeypot, admin, takedown |
| 8 | Alias propio, expiración y retención de IPs |
| 9 | Suite de aceptación, README y despliegue |

## Arranque local

Requisitos: Node.js 24 o superior.

```bash
npm ci
cp .env.example .env
# genera los secretos y edítalos en .env
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # IP_HASH_SECRET
openssl rand -hex 32   # FORM_TOKEN_SECRET (opcional)
npm run dev
```

La primera ejecución aplica `migrations/001_init.sql` y
`migrations/002_retention_index.sql` sobre `file:./data/local.db`.

Comprobaciones rápidas:

```bash
curl -s http://localhost:3000/health
# {"status":"ok"}

curl -s -X POST http://localhost:3000/api/v1/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/ruta/larga"}'

curl -i http://localhost:3000/<alias>
```

## Scripts

```bash
npm run dev          # tsx watch
npm run build        # tsc a dist/
npm start            # node dist/server.js
npm run db:migrate   # aplica migraciones pendientes (requiere build)
npm run db:baseline  # registra migraciones cuyo esquema ya existe
npm run typecheck    # tsc --noEmit
npm test             # Vitest (191 tests)
npm run test:watch
```

## Estructura del proyecto

`src/` se organiza por capas explícitas; `app.ts` es el único composition
root:

```
src/
├── server.ts · app.ts · config.ts · logger.ts
├── domain/     reglas puras de enlaces y blocklist
├── infra/      SQL, caché, buffer de clics y jobs
├── security/   HMAC de IP, honeypot y rate limiter
├── http/       rutas, middleware y presentadores
└── ui/         SSR puro (layout y páginas)
tests/          espejo de src/ (helpers + integración HTTP)
```

Reglas de dependencia: `domain` no importa Express, libSQL, `fs` ni pino;
`infra` y `security` no importan `http`/`ui`; `http` no importa la persistencia
de `infra`. El detalle y el árbol completo están en
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Variables de entorno

| Variable | Obligatoria | Default | Uso |
| --- | --- | --- | --- |
| `BASE_URL` | Sí | — | Origen público para construir enlaces cortos |
| `ADMIN_TOKEN` | Sí | — | Bearer del admin (mín. 16 caracteres) |
| `IP_HASH_SECRET` | Sí | — | HMAC de IPs para límites, cuota y dedupe |
| `FORM_TOKEN_SECRET` | No | `ADMIN_TOKEN` | Firma del honeypot; conviene uno distinto |
| `DATABASE_URL` | No | `file:./data/local.db` | SQLite local o `libsql://…` de Turso (remota obligatoria en producción) |
| `DATABASE_AUTH_TOKEN` | No | — | Token de Turso |
| `ALLOW_LOCAL_DB` | No | `false` | Permite `file:` en producción de forma explícita |
| `IP_RETENTION_DAYS` | No | `45` | Días antes de anonimizar el hash de IP (30–90) |
| `TRUST_PROXY` | No | `0` | `1` detrás del proxy de Render |
| `PORT` | No | `3000` | Puerto HTTP |
| `LOG_LEVEL` | No | `info` | Nivel de pino |
| `ABUSE_CONTACT_EMAIL` | No | — | Correo visible en el pie |
| `NODE_ENV` | No | `development` | `production` activa caché estática |

## API

| Método | Ruta | Auth | Respuesta |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `200 {"status":"ok"}` |
| `GET` | `/ready` | — | `200` si la DB responde; `503` si no |
| `POST` | `/api/v1/links` | — | `201` enlace + `Location` |
| `GET` | `/api/v1/links/:alias` | — | `200` metadata, `404`, `410` |
| `GET` | `/:alias` | — | `302 no-store`, `404`, `410` |
| `POST` | `/links` | Honeypot | `303 /?created=alias` |
| `DELETE` | `/api/v1/links/:alias` | Bearer | `204`, `404` |
| `POST` | `/api/v1/admin/blocklist` | Bearer | `201` alta/actualización |

Crear con alias y expiración:

```bash
curl -s -X POST http://localhost:3000/api/v1/links \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/promo",
    "alias": "promo-2026",
    "expiresAt": "2026-12-31T23:59:00.000Z"
  }'
```

La API solo acepta `Content-Type: application/json`; un formulario
`application/x-www-form-urlencoded` recibe `415`. El formulario SSR usa su
propio parser únicamente en `POST /links`.

La expiración debe estar entre 5 minutos y 1 año desde ahora. Un alias
duplicado devuelve `409`. Un enlace vencido o retirado devuelve `410`, nunca
`404`: existió y ya no está disponible.

El formulario SSR también acepta alias propio y una fecha de caducidad en UTC
(`<input type="datetime-local">` + etiqueta UTC para evitar ambigüedades).

## Procedimiento de takedown

El token admin nunca se registra en logs (pino redacta `Authorization` y
cookies). Todas las rutas admin responden `401` sin `Authorization: Bearer`.

1. Verificar el reporte recibido en `ABUSE_CONTACT_EMAIL`.
2. Deshabilitar el enlace (idempotente, no borra la fila):

   ```bash
   curl -i -X DELETE http://localhost:3000/api/v1/links/ALIAS \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

   El siguiente `GET /ALIAS` devuelve `410` de inmediato porque el takedown
   invalida la entrada de caché. La fila no se borra: el alias queda reservado
   (no puede reutilizarse) y el `410` conserva la diferencia entre «nunca
   existió» (`404`) y «existió y fue retirado» (`410`).

3. Si el dominio es reincidente, bloquearlo y todos sus subdominios:

   ```bash
   curl -s -X POST http://localhost:3000/api/v1/admin/blocklist \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"domain":"dominio-malicioso.example"}'
   ```

   La respuesta incluye `disabledLinks`: cuántos enlaces **ya existentes** de
   ese dominio se deshabilitaron en el mismo paso (motivo `domain_blocked`;
   la caché de redirects se vacía, así que dejan de redirigir de inmediato).
   Repetir el alta es idempotente y devuelve `0`.

   Para desactivar una entrada sin borrarla: enviar `{"enabled":false}`.
   Desactivarla permite crear enlaces nuevos otra vez, pero **no reactiva**
   los que ya se retiraron (el takedown es irreversible). El alta manual
   invalida la caché de blocklist (TTL normal: 60 s).

4. Documentar la decisión (fecha, alias, dominio, motivo) en el canal interno.

La blocklist parte de `seed/blocklist.json` (acortadores y redirectores
conocidos) y añade el propio dominio de `BASE_URL` para evitar bucles. Las
entradas **de la semilla** solo impiden crear enlaces nuevos; las altas
manuales además retiran los existentes (ver arriba). Un enlace suelto se
retira con `DELETE /api/v1/links/:alias`.

## Retención y privacidad

- La IP se guarda como `HMAC-SHA256(IP_HASH_SECRET, IPv4 o prefijo /64 IPv6)`.
- `jobs/retention.ts` corre al arrancar y cada 6 h: pone `created_ip_hash = NULL`
  en filas con `created_at` anterior a `IP_RETENTION_DAYS`.
- Los logs HTTP **no** incluyen la IP del cliente (`remoteAddress` y
  `remotePort` se eliminan del serializer de `pino-http`), ni cabeceras de
  proxy (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`), ni `Referer`, ni
  cuerpos de error: la única huella de red persistente es el HMAC con
  retención limitada.
- **Consecuencia consciente:** esas filas dejan de contar para la cuota y el
  dedupe de esa IP. Es una decisión de privacidad, no un bug.

## Límites de abuso

- Peticiones mutantes (POST/PUT/PATCH/DELETE): 120/min por IP, antes de
  parsear el cuerpo.
- Crear: 5/min, 30/h y 100/día por IP + 2000/h global. El cupo se consume
  después de validar el cuerpo (Zod, honeypot y token), así que un envío
  inválido no lo gasta.
- Redirects: 300/min por IP.
- Lecturas públicas (`GET /api/v1/links/:alias` y `GET /?created=`): 60/min por
  IP, con `429` + `Retry-After`. La portada sin `created` no se limita.
- Cuota: 50 enlaces activos por IP; al superarla, `429` con `Retry-After`
  estimado a partir de la caducidad más próxima.
- Dedupe: misma URL normalizada + misma IP + misma caducidad (o ambas sin
  caducidad) en 24 h devuelve el alias existente. Si se pide una caducidad
  distinta se crea un enlace nuevo, para no devolver uno con otra vida útil.
- Formulario: token HMAC (`timestamp.firma`) ligado al HMAC de la IP, con
  antigüedad mínima de 3 s y máxima de 30 min, campo trampa `website` y
  rechazo genérico.
- Blocklist: dominio registrable con `tldts`; bloquea subdominios, no sufijos
  parecidos (`example.co.uk` ≠ `notexample.co.uk`) y rechaza sufijos públicos
  (`com`, `co.uk`) para no bloquear medio Internet.

## Despliegue en Render

`render.yaml` define el servicio. Pasos:

1. Crear una base en Turso y copiar `libsql://…` y el auth token.
2. En Render, crear un Blueprint desde el repositorio.
3. Rellenar los secretos marcados `sync: false` (`BASE_URL`,
   `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `ABUSE_CONTACT_EMAIL`).
4. Dejar `TRUST_PROXY=1` y `IP_RETENTION_DAYS=45`.
5. Verificar `/ready` (incluye una consulta a la DB) y crear un enlace de
   prueba.

El build usa `npm ci --include=dev` porque `NODE_ENV=production` haría que npm
omitiera TypeScript y `npm run build` fallaría.

`preDeployCommand: npm run db:migrate` aplica las migraciones antes de levantar
la instancia nueva. Si una migración falla, Render marca el deploy como fallido
pero **la instancia anterior sigue sirviendo**. El arranque también las ejecuta
como red de seguridad: ahí un fallo sí tumba el proceso (fail-fast, no se sirve
tráfico con el esquema incompleto).

### Migraciones y recuperación

Las migraciones son idempotentes (`CREATE TABLE/INDEX IF NOT EXISTS`): una DB
con el esquema ya creado pero `schema_migrations` vacío —un dump restaurado, una
DB creada a mano o un intento anterior interrumpido— arranca igualmente y el
registro se completa en la primera ejecución.

Si el esquema preexistente **no coincide** con las migraciones, `IF NOT EXISTS`
no lo detecta. Para revisarlo con Turso CLI:

```bash
turso db shell <db> "SELECT name FROM schema_migrations;"
turso db shell <db> "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';"
```

Y para registrar lo que ya existe sin volver a ejecutar SQL (con `--dry-run`
primero, que solo informa):

```bash
npm run build
DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npm run db:baseline -- --dry-run
DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npm run db:baseline
```

Los comandos usan las mismas variables que la app (en local basta con tener
`.env`; en Render ya están todas definidas).

`db:baseline` solo registra una migración si **todos** sus objetos existen y
sale con código 1 si alguna queda pendiente (esquema incompleto o no
reconocible). Si no hay datos que conservar, lo más simple es recrear la DB
(`turso db create`) y actualizar `DATABASE_URL` y `DATABASE_AUTH_TOKEN` en
Render.

Si el deploy falla con `table … already exists` y `schema_migrations` está
vacía, es exactamente este caso: baseline o recrear. El error de arranque ahora
incluye esa pista.

El plan `free` de Render duerme la instancia; este MVP asume **una sola
instancia always-on** porque caché, rate limiter y buffer de clics viven en
memoria. Usa el plan `starter` o superior.

Render envía `SIGTERM` en cada deploy. El orden del apagado es:
dejar de aceptar conexiones → detener retención → vaciar buffer de clics →
cerrar DB → salir. Un crash duro puede perder hasta ~5 s de clics.

## Flujo del sistema (trazas A–D)

### A. Crear un enlace por API

```mermaid
sequenceDiagram
  participant C as Cliente
  participant A as app.ts
  participant S as links/service.ts
  participant V as validate + blocklist
  participant D as libSQL
  C->>A: POST /api/v1/links
  A->>A: IP real, rate limit, Zod
  A->>S: create(input)
  S->>V: normalizar URL + dominio bloqueado
  V-->>S: URL canónica / domain_blocked
  S->>D: transacción: dedupe, cuota, INSERT
  D-->>S: fila
  S-->>A: LinkRecord
  A-->>C: 201 + Location
```

### B. Redirect

```mermaid
sequenceDiagram
  participant C as Cliente
  participant R as routes/redirect.ts
  participant S as service
  participant L as AliasCache
  participant D as libSQL
  C->>R: GET /:alias
  R->>R: rate limit de redirects
  R->>S: resolve(alias)
  S->>L: get(alias)
  alt hit vigente
    L-->>S: destino + expiresAt/disabledAt
  else miss
    S->>D: SELECT
    D-->>S: fila (404 no se cachea)
    S->>L: set(entrada)
  end
  S->>S: clickBuffer.record()
  S-->>R: destino o gone
  R-->>C: 302 no-store / 404 / 410
```

### C. Takedown

```mermaid
sequenceDiagram
  participant O as Operador
  participant A as API admin
  participant S as service
  participant L as AliasCache
  participant D as libSQL
  O->>A: DELETE /api/v1/links/:alias (Bearer)
  A->>A: sha256 + timingSafeEqual
  A->>S: disable(alias)
  S->>D: UPDATE disabled_at/reason
  S->>L: delete(alias)
  S-->>A: ok
  A-->>O: 204
  Note over D,L: el siguiente GET devuelve 410
```

### D. Deploy con clics pendientes

```mermaid
sequenceDiagram
  participant R as Render
  participant P as server.ts
  participant B as ClickBuffer
  participant D as libSQL / Turso
  R->>P: SIGTERM
  P->>P: server.close() + retention.stop()
  P->>B: close() → flush()
  B->>D: batch UPDATE clicks
  P->>D: close()
  P-->>R: process.exit(0)
```

## Criterios de aceptación cubiertos

La suite está en `tests/**/*.test.ts`, espejo de las capas de `src/`:

- Health, CSP, estáticos y 404 HTML/JSON → `tests/http/health.test.ts`.
- Crear por API/formulario, alias duplicado, 410, XSS →
  `tests/http/api-links.test.ts` y `tests/http/home.test.ts`.
- Dedupe, cuota, rate limit 429 + `Retry-After` →
  `tests/http/rate-limits.test.ts`, `tests/domain/links/service.abuse.test.ts`,
  `tests/security/rate-limit.test.ts`.
- 300 resoluciones = 1 lectura, TTL, 404 no cacheado →
  `tests/domain/links/service.abuse.test.ts`.
- Blocklist semilla/manual, subdominios, TTL 60 s →
  `tests/infra/db/blocklist-store.test.ts`.
- Honeypot manipulado/ausente/rápido → `tests/security/form-token.test.ts` y
  `tests/http/abuse.test.ts`.
- Token admin constante e invalidez →
  `tests/http/middleware/admin-auth.test.ts`; redacción de logs →
  `tests/logger.test.ts`.
- Takedown invalida caché → `tests/http/admin.test.ts`.
- Retención y su efecto en cuota → `tests/infra/jobs/retention.test.ts`.
- SIGTERM persiste clics → `tests/server.shutdown.test.ts`.

## Limitaciones conocidas

- Estado en memoria: caché, rate limiter y buffer se pierden en cada deploy y
  no se comparten entre instancias. Una sola instancia always-on.
- Un crash duro (no `SIGTERM`) puede perder hasta ~5 s de clics.
- La blocklist tarda hasta 60 s en reflejar cambios hechos directamente en la
  DB; el endpoint admin invalida la caché al instante.
- El honeypot frena bots simples, no humanos ni ataques dirigidos. La defensa
  real son las cuotas IP/globales y la blocklist.
- No hay cuentas ni recuperación de enlaces: `/?created=<alias>` solo muestra
  datos públicos y cualquiera puede fabricarlo.
- No hay formulario de reporte; el canal es `ABUSE_CONTACT_EMAIL` y el
  procedimiento de takedown de arriba.
