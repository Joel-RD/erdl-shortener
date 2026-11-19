# Acortador de URLs · Disección del plan y fases de construcción (v3)

Objetivo de esta guía: que cada vez que agregues código sepas **qué hace, por qué existe y con quién habla**. Primero se desarma el plan v2 por secciones; después se reordena en fases pequeñas donde cada una termina con algo que puedes ejecutar y comprobar.

## 1. Mapa mental: las capas

Antes de los detalles, el sistema se entiende como tres capas más piezas transversales:

```text
Cliente (navegador / curl)
   │
   ▼
[ Entrada HTTP ]  app.ts: rutas, middlewares (helmet, límites, logs)
   │
   ▼
[ Servicio ]      links/service.ts: reglas de negocio (crear, resolver, deshabilitar)
   │   usa → validate.ts (limpia la URL), alias.ts (genera/valida alias)
   ▼
[ Datos ]         db/client.ts → Turso/libSQL (tablas links, blocked_domains)

Transversales (se enchufan a las capas de arriba):
  abuse/*   → rate-limit, blocklist, ip, form-token (protegen la entrada y el servicio)
  cache/*   → alias-cache (acelera la lectura en el redirect)
  click-buffer → acumula clics y los escribe en lote
  jobs/*    → retención de IPs (tarea periódica)
  ui/*      → render de HTML en servidor
```

Regla de oro para entender el código: **las rutas no contienen lógica de negocio**, solo traducen HTTP ↔ servicio. Si algo se decide (¿es válida esta URL?, ¿está vencido?), vive en el servicio o en módulos puros.

## 2. Disección por secciones

### 2.1 Alcance

- **Qué es:** el contrato de lo que se construye y lo que se deja fuera a propósito.
- **Por qué importa:** cada cosa excluida (cuentas, CAPTCHA, panel admin) explica por qué otras existen. Sin cuentas no hay dueños de enlaces, por eso el takedown lo hace un admin con un token y por eso `/?created=<alias>` no puede asumir propiedad.
- **Interacción:** condiciona seguridad y abuso. Al ser anónimo, la defensa descansa en cuotas por IP, honeypot y blocklist.

### 2.2 Rutas

Son la superficie pública. Agrúpalas mentalmente así:

- **Crear:** `POST /links` (formulario, responde con 303 redirect a `/?created=alias`, patrón Post/Redirect/Get para que recargar no cree duplicados) y `POST /api/v1/links` (JSON). Ambas llaman al **mismo** servicio; solo cambia cómo se entra y cómo se responde.
- **Resolver:** `GET /:alias` → 302 con `no-store`. Es la ruta más caliente y la que más cuida el rendimiento. `no-store` evita que navegadores o proxies recuerden el destino y se salten el conteo de clics o el takedown.
- **Consultar:** `GET /api/v1/links/:alias` devuelve metadata.
- **Administrar:** `DELETE /api/v1/links/:alias` y `POST /api/v1/admin/blocklist`, protegidas por Bearer.
- **Salud:** `GET /health` para Render.
- **Trampa a entender:** `/:alias` captura *cualquier* ruta de un solo segmento. Por eso se registra **al final** y por eso existe la lista de alias reservados (ver 2.3).

### 2.3 Reglas de negocio

**Alias (`links/alias.ts`)**

- Generado: 7 caracteres base62 con `crypto.randomInt` (aleatorio criptográfico, no `Math.random`, para que no sea predecible). Si choca con uno existente, reintenta.
- Personalizado: 3–32 caracteres `[A-Za-z0-9_-]`; si ya existe → 409.
- **Reservados:** `api, admin, links, report, health, static, favicon.ico, robots.txt` + nombres de archivos de `public/`. Si alguien registrara `styles.css` como alias, la ruta `/:alias` podría tapar el archivo estático (o viceversa).

**Validación de URL (`links/validate.ts`)**

- Es una función pura: entra texto, sale URL normalizada o error. Pasos: `new URL` → solo http/https → `domainToASCII` (convierte dominios Unicode a punycode, evita homógrafos engañosos) → host en minúsculas → sin credenciales (`user:pass@`) → sin localhost ni IP privada (evita que el acortador apunte a tu red interna) → máx. 4096 caracteres.
- Su salida alimenta tres cosas: `url_hash` (dedupe), `domain` (blocklist) y `url` (destino).

**Expiración**

- Opcional, entre 5 min y 1 año. Al resolver: si `expires_at < ahora` → 410 (existió y ya no está), a diferencia del 404 (nunca existió).

**Duplicados y cuotas**

- Misma URL normalizada + mismo IP-hash en 24 h → devuelve el alias existente (consulta con el índice `(url_hash, created_ip_hash, created_at)`).
- Cuota de enlaces activos por IP (≈50): cuenta con el índice `created_ip_hash`.

**Blocklist (`abuse/blocklist.ts`)**

- Usa `tldts` para obtener el *dominio registrable* (`a.b.example.co.uk` → `example.co.uk`), y bloquea ese dominio y todos sus subdominios.
- Fuentes: JSON semilla (en el repo) + tabla `blocked_domains` (editable en caliente por el endpoint admin) con caché de 60 s para no consultar la DB en cada creación.
- Debe incluir el propio dominio del acortador y otros acortadores, para evitar cadenas de redirección y bucles.

### 2.4 Rendimiento y datos

**Caché LRU alias → URL (`cache/alias-cache.ts`)**

- Guarda resultados de resolución 30–60 s con tamaño máximo (LRU: al llenarse, expulsa lo menos usado).
- Existe porque con Turso remoto cada lectura es una llamada de red facturable.
- Se **invalida** en el takedown. Los 404 no se cachean (si no, un alias recién creado parecería inexistente).
- ⚠ Detalle que el plan no menciona: la entrada de caché debe guardar también `expires_at` y estado, y comprobarlos en cada hit; si no, un enlace vencido seguiría redirigiendo hasta 60 s.

**Índices**

- Cada índice responde a una consulta concreta: cuota (`created_ip_hash`), dedupe (compuesto), blocklist/estadísticas (`domain`), limpieza de vencidos (`expires_at`). Si no tienes la consulta, no necesitas el índice.

**Buffer de clics (`abuse/click-buffer.ts`)**

- En vez de un `UPDATE` por clic, se acumulan en memoria y se escriben en lote cada 5 s o 200 eventos (`batch` de libSQL).
- Coste: si el proceso muere de golpe se pierden hasta \~5 s de clics. Por eso existe el apagado limpio.

**Apagado limpio (`server.ts`)**

- Ante `SIGTERM`/`SIGINT`: dejar de aceptar conexiones → vaciar buffer de clics → cerrar cliente DB → salir. Render manda SIGTERM en cada deploy, así que ocurre con frecuencia, no es un caso raro.

**Retención de IPs (`jobs/retention.ts`)**

- `setInterval` al arrancar que pone `created_ip_hash = NULL` pasados 30–90 días. Es una decisión de privacidad.
- Consecuencia a conocer: tras anular el hash, esos enlaces dejan de contar para la cuota y el dedupe de esa IP.

### 2.5 Seguridad

| Pieza | Qué hace | Por qué así |
| --- | --- | --- |
| Honeypot firmado (`form-token.ts`) | Campo oculto con `timestamp.firma`; el servidor verifica la firma HMAC y que pasaron ≥ N s | Un bot rellena campos ocultos y envía instantáneamente; sin firma, el bot podría inventar el timestamp |
| Hash de IP (`ip.ts`) | `HMAC-SHA256(secreto, ip)` | Un hash con sal es reversible por fuerza bruta (solo hay 2³² IPv4) si se filtra la sal; con HMAC y secreto, no |
| Token admin | Compara `sha256(recibido)` con `sha256(esperado)` vía `timingSafeEqual` | Hashear primero iguala longitudes (timingSafeEqual lo exige) y evita filtrar información por tiempo |
| Rate limiter (`rate-limit.ts`) | Ventanas por IP en memoria, tope de \~100k entradas, limpieza periódica | Sin tope, un atacante con un /64 IPv6 podría inflar la memoria; la interfaz `RateLimiter` permite cambiarlo por Redis |
| Límites | Crear 5/min, 30/h, 100/día por IP (IPv6 por /64) + global; redirects 300/min | Responde 429 con `Retry-After` |
| CSP + Helmet | `script-src 'self'`; el botón de copiar vive en `public/app.js` | Con CSP estricta no se permiten scripts inline |
| Escape SSR | Toda salida HTML se escapa | Evita XSS por URL o alias maliciosos |
| `TRUST_PROXY` | Cuántos proxies confiar para leer la IP real | Detrás de Render, mal configurado = todos comparten IP o la IP es falsificable |
| Logs (pino) | Redacta `authorization` y cookies | El token admin nunca debe quedar en logs |
| `/?created=alias` | Solo muestra datos públicos | Cualquiera puede fabricar esa URL |

### 2.6 Abuso sin página de reporte

- No hay formulario, así que el canal es un correo (`ABUSE_CONTACT_EMAIL`) visible en el pie de todas las páginas, más un procedimiento escrito: revisar → `DELETE` del enlace → (opcional) añadir dominio a la blocklist.
- Es un requisito operativo, no código decorativo: un acortador anónimo atrae phishing.

### 2.7 Esquema

- `links`: una fila por enlace. `clicks` y `last_clicked_at` los actualiza el buffer; `disabled_at/disabled_reason` marcan el takedown sin borrar la fila (así el alias responde 410 y no puede reutilizarse).
- `blocked_domains`: lista editable; `source` distingue semilla de manual; `enabled` permite apagar una entrada sin borrarla.
- `schema_migrations`: el runner propio anota qué migraciones ya corrió.
- Dev/tests: SQLite local con WAL. Prod: Turso remoto. Mismo cliente libSQL, distinta URL.

### 2.8 Estructura de archivos

Cómo se conectan los módulos (flecha = "depende de"):

```text
server.ts ──► app.ts ──► rutas ──► links/service.ts ──► db/client.ts
   │            │                     │   │   │
   │            │                     │   │   └─► links/alias.ts
   │            │                     │   └─────► links/validate.ts ─► abuse/blocklist.ts
   │            │                     ├─────────► cache/alias-cache.ts
   │            │                     └─────────► abuse/click-buffer.ts
   │            ├─► abuse/rate-limit.ts, abuse/ip.ts, abuse/form-token.ts
   │            └─► ui/render.ts, ui/pages.ts
   ├─► config.ts (lo lee todo el mundo)
   ├─► db/migrate.ts (al arrancar)
   └─► jobs/retention.ts, shutdown (flush del buffer)
```

### 2.9 Deploy y criterios de aceptación

- Una sola instancia always-on: caché, rate limiter y buffer viven en memoria; con varias instancias o con el plan free (que duerme) se rompen los supuestos.
- Los criterios de aceptación son tu lista de tests de integración: cada línea es un `it(...)` en Vitest + supertest.

## 3. Cuatro trazas para entender cómo interactúa todo

**A. Crear un enlace por API**

1. `POST /api/v1/links` → middleware: IP real (`ip.ts`) → rate limiter → zod valida el body.
2. `service.create`: `validate` normaliza → `blocklist` consulta dominio → dedupe (¿ya existe para esta URL + IP-hash?) → cuota de enlaces activos.
3. `alias` genera (o valida el personalizado) → `INSERT` → si choca, reintento o 409.
4. Responde 201 con el link corto.

**B. Redirect (`GET /:alias`)**

1. Rate limiter de redirects → ¿alias en caché?
2. Si no: `SELECT` en DB → si existe, se cachea.
3. Evalúa estado: no existe → 404; `disabled_at` o vencido → 410; si no, registra clic en el buffer y responde 302 `no-store`.

**C. Takedown**

1. `DELETE /api/v1/links/:alias` → compara token con `timingSafeEqual`.
2. `UPDATE disabled_at, disabled_reason` → **invalida la caché** de ese alias → siguiente GET devuelve 410.

**D. Deploy con clics pendientes**

1. Render envía SIGTERM → `server.close()` → flush del buffer → cierre del cliente DB → `process.exit`.

## 4. Puntos débiles detectados en el plan (para decidir antes de programar)

1. **Caché sin estado de expiración** (ver 2.4): guardar `expires_at`/`disabled` en la entrada.
2. **Retención vs. cuota/dedupe:** anular el hash libera la cuota de esa IP; está bien, pero conviene que sea una decisión consciente y documentada.
3. **Estado en memoria** (rate limiter, buffer) se pierde en cada deploy; aceptable en MVP, pero anótalo en el README.
4. **Honeypot** frena bots simples, no humanos ni bots dirigidos; la protección real son cuotas y blocklist.
5. **Clics en caída brusca** (crash, no SIGTERM): se pierden hasta \~5 s; asumible.

## 5. Nuevo plan: 10 fases pequeñas

Criterio de orden: **primero lo puro y verificable (funciones sin red), luego lo que toca la DB, luego lo que protege.** Cada fase termina con un *checkpoint* ejecutable y con una pregunta de comprensión para comprobar que entiendes lo añadido.

### Fase 0 · Esqueleto y configuración

- **Archivos:** `package.json`, `tsconfig.json` (strict), `config.ts`, `app.ts`, `server.ts`, `GET /health`.
- **Qué aprendes:** cómo `config.ts` valida el entorno con Zod y falla al arrancar si falta algo; por qué `app.ts` (construye la app) está separado de `server.ts` (la pone a escuchar): para poder testear con supertest sin abrir puerto.
- **Checkpoint:** `npm run dev` y `curl /health` responde 200; `npm test` corre un test trivial.
- **Pregunta:** ¿qué pasa si `ADMIN_TOKEN` no está definido y por qué es mejor que falle al inicio?

### Fase 1 · Base de datos y migraciones

- **Archivos:** `db/client.ts`, `db/migrate.ts`, `001_init.sql` (tablas e índices).
- **Qué aprendes:** cómo el runner consulta `schema_migrations`, aplica solo las pendientes y es idempotente; diferencia entre `file:local.db` y Turso.
- **Checkpoint:** arrancar dos veces seguidas no repite migraciones; test que crea una DB temporal y verifica que existen las tablas.
- **Pregunta:** ¿qué consulta justifica cada índice?

### Fase 2 · Módulos puros: validación y alias

- **Archivos:** `links/validate.ts`, `links/alias.ts` (+ lista de reservados) y sus tests.
- **Qué aprendes:** la normalización de URL paso a paso, base62 con `randomInt`, reglas del alias personalizado. Aún no hay HTTP ni DB: son entrada → salida.
- **Checkpoint:** tabla de casos en Vitest (`javascript:`, `http://user:pw@x`, `http://127.0.0.1`, dominio Unicode, URL de 5000 caracteres, alias `api`, alias `styles.css`).
- **Pregunta:** ¿por qué `domainToASCII` forma parte de la seguridad y no solo del formato?

### Fase 3 · Servicio y API de enlaces (sin caché)

- **Archivos:** `links/service.ts` (crear, resolver), rutas `POST /api/v1/links`, `GET /:alias`, `GET /api/v1/links/:alias`.
- **Qué aprendes:** cómo el servicio orquesta validate + alias + DB; reintento ante colisión; diferencia 404 vs. 410; por qué `/:alias` se registra al final.
- **Checkpoint:** con `curl`, crear un enlace y seguir el 302; metadata devuelve clics (aún en 0).
- **Pregunta:** ¿qué devuelve resolver un alias vencido y por qué no es 404?

### Fase 4 · Interfaz SSR y estáticos

- **Archivos:** `ui/render.ts` (escape), `ui/pages.ts`, `public/styles.css`, `public/app.js`, rutas `GET /` y `POST /links` (303), Helmet con CSP.
- **Qué aprendes:** Post/Redirect/Get; por qué todo se escapa; por qué el JS va en archivo y no inline (CSP); por qué `/?created=` solo muestra datos públicos.
- **Checkpoint:** crear desde el navegador, ver la tarjeta, copiar el enlace; test de XSS con `<script>` en alias/URL.
- **Pregunta:** ¿qué se rompería si pusieras el script de copiar dentro del HTML?

### Fase 5 · Rendimiento: caché, buffer de clics y apagado limpio

- **Archivos:** `cache/alias-cache.ts`, `abuse/click-buffer.ts`, handler de señales en `server.ts`.
- **Qué aprendes:** LRU con TTL; qué se guarda en la entrada (destino **y** `expires_at`/estado); batch de libSQL; el orden del shutdown (parar de aceptar → flush → cerrar DB).
- **Checkpoint:** test: 300 resoluciones hacen 1 sola lectura a DB; enviar SIGTERM con clics pendientes y comprobar que quedaron persistidos.
- **Pregunta:** ¿por qué los 404 no se cachean?

### Fase 6 · Abuso I: IP, límites, cuotas y dedupe

- **Archivos:** `abuse/ip.ts` (HMAC, /64 de IPv6, `TRUST_PROXY`), `abuse/rate-limit.ts` (interfaz + versión en memoria con tope), cuotas y dedupe en el servicio.
- **Qué aprendes:** de dónde sale la IP real tras un proxy; por qué HMAC y no sal; cómo la evicción protege la memoria.
- **Checkpoint:** la sexta creación en un minuto devuelve 429 con `Retry-After`; misma URL desde la misma IP devuelve el alias existente.
- **Pregunta:** ¿qué ocurre si `TRUST_PROXY` está mal configurado?

### Fase 7 · Abuso II: blocklist, honeypot y administración

- **Archivos:** `abuse/blocklist.ts` (+ JSON semilla, caché 60 s), `abuse/form-token.ts`, middleware de auth admin, `DELETE /api/v1/links/:alias`, `POST /api/v1/admin/blocklist`, redacción de logs en pino.
- **Qué aprendes:** dominio registrable con `tldts`; firma y verificación de un token con tiempo; comparación en tiempo constante; cómo el takedown invalida la caché de la Fase 5.
- **Checkpoint:** dominio bloqueado → 422 genérico; timestamp manipulado o ausente → rechazado; tras `DELETE`, el siguiente `GET` da 410; el token no aparece en los logs.
- **Pregunta:** ¿por qué se hashean ambos tokens antes de `timingSafeEqual`?

### Fase 8 · Ciclo de vida: alias propio, expiración y retención

- **Archivos:** soporte de `alias` y `expiresAt` en el servicio y la UI, `jobs/retention.ts`.
- **Qué aprendes:** validación de rangos (5 min–1 año), 409 por conflicto, cómo el job periódico interactúa con cuota y dedupe (ver punto 2 de la sección 4).
- **Checkpoint:** alias duplicado → 409; expiración vencida → 410; el job deja `created_ip_hash` en NULL pasado el umbral (probar con un umbral de segundos).
- **Pregunta:** ¿qué ventaja tiene deshabilitar la fila en vez de borrarla?

### Fase 9 · Cierre: pruebas, README y despliegue

- **Archivos:** tests de integración que cubran **todos** los criterios de aceptación, `README` con procedimiento de takedown y limitaciones (estado en memoria), `ABUSE_CONTACT_EMAIL` en el pie, configuración de Render.
- **Qué aprendes:** cómo se comporta el sistema en producción real (SIGTERM en deploy, una sola instancia, variables de entorno).
- **Checkpoint:** suite en verde; deploy en Render; healthcheck OK; un enlace creado en producción redirige.
- **Entregable final:** diagrama actualizado del flujo (las trazas A–D de la sección 3).

## 6. Cómo trabajar cada fase

1. Lee la sección de la disección que corresponde.
2. Escribe primero el test del checkpoint (aunque falle).
3. Agrega el código mínimo para que pase.
4. Responde la pregunta de comprensión con tus palabras; si no puedes, relee el módulo antes de pasar a la siguiente fase.

Si quieres, empezamos por la Fase 0 y voy explicando cada archivo línea a línea a medida que lo escribimos.
