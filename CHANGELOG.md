# Changelog

Todos los cambios relevantes de este proyecto se registran aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el versionado [Semantic Versioning](https://semver.org/lang/es/).

> `erdl` es un MVP anónimo sin cuentas. Las versiones `0.x` pueden cambiar la
> superficie pública (API, HTML y variables de entorno) sin aviso de
> compatibilidad.

## [0.1.0-alpha.1] - 2026-11-20

Primera alpha pública. El alcance funcional del MVP está completo (fases 0–9
del [plan](./docs/plan-MVP-acortador-url.md)); esta versión se publica para
validar despliegue, observabilidad y el procedimiento de abuso en producción.

### Added

- Creación de enlaces por API JSON y por formulario SSR, con alias aleatorio o
  personalizado, caducidad opcional y dedupe.
- Redirección `302` con `no-store`, caché LRU de alias, contador de clics en
  buffer y apagado limpio ante `SIGTERM`.
- Límites por IP y globales, cuota de enlaces activos, honeypot firmado,
  blocklist de dominios, HMAC de IP y retención/anonimización del hash.
- Takedown administrativo con token Bearer que invalida la caché al instante.
- `/health`, `/ready`, migraciones idempotentes, comandos `db:migrate` y
  `db:baseline`, y blueprint de Render en `render.yaml`.
- CI con typecheck, tests, build y auditoría de dependencias de producción.
- `LICENSE` (MIT) y este `CHANGELOG.md` para el repositorio público.
- Página pública `/privacidad`: datos almacenados, finalidad, retención del
  hash de IP, cookies/terceros, canal de reportes y medidas de seguridad.
  Está enlazada desde el pie de todas las páginas y el alias `privacidad`
  queda reservado.

### Changed

- La versión del paquete pasa a `0.1.0-alpha.1` y se etiqueta
  `v0.1.0-alpha.1`.
- El texto de retención de la página de privacidad se deriva de
  `IP_RETENTION_DAYS`, no de una constante copiada en el HTML.

### Limitaciones conocidas de esta alpha

- Una sola instancia always-on: caché, limitador y buffer viven en memoria.
- Un crash duro puede perder hasta ~5 s de clics.
- Sin cuentas, panel de administración ni formulario de reporte: el canal es
  el correo configurado en `ABUSE_CONTACT_EMAIL`.
- La API y el HTML pueden cambiar entre versiones `0.x`.
