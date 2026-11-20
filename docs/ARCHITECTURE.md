# Arquitectura

El proyecto usa capas explícitas. La regla práctica es simple: las reglas de
negocio no conocen Express ni SQL, y la infraestructura no conoce HTTP.

## Árbol

```
src/
├── server.ts                  # bootstrap: migra, escucha, apaga
├── app.ts                     # composition root: cablea todo
├── config.ts                  # entorno validado con Zod
├── logger.ts                  # pino
│
├── domain/                    # reglas puras
│   ├── links/
│   │   ├── types.ts           # modelos y puertos (caché, clics, blocklist)
│   │   ├── alias.ts
│   │   ├── validate.ts
│   │   ├── private-address.ts # detección de IPs privadas/reservadas
│   │   ├── expiration.ts
│   │   ├── repository.ts      # PUERTO de persistencia
│   │   └── service.ts         # casos de uso de enlaces
│   └── abuse/
│       └── blocklist.ts       # normalización y comparación de dominios
│
├── infra/                     # implementaciones concretas
│   ├── db/
│   │   ├── client.ts
│   │   ├── migrate.ts · migrate-cli.ts
│   │   ├── links-repository.ts    # implementa domain/links/repository
│   │   └── blocklist-store.ts     # implementa domain/abuse/blocklist
│   ├── cache/alias-cache.ts
│   ├── clicks/click-buffer.ts
│   └── jobs/retention.ts
│
├── security/                  # primitivas transversales
│   ├── ip.ts                  # normalización + HMAC de IP
│   ├── form-token.ts          # honeypot firmado
│   └── rate-limit.ts          # limitador en memoria
│
├── net/                       # parsers puros compartidos
│   └── ip.ts                  # IPv4/IPv6 textual, sin red ni DNS
│
├── http/                      # adaptador HTTP
│   ├── routes/
│   │   ├── home.ts · redirect.ts
│   │   ├── api-links.ts · api-admin.ts
│   │   └── health.ts
│   ├── middleware/
│   │   ├── admin-auth.ts · content-type.ts · errors.ts
│   │   ├── logging.ts · rate-limits.ts · security-headers.ts
│   ├── presenters/
│   │   ├── links.ts           # DTO de la API
│   │   └── home-form.ts       # fechas del formulario SSR
│   └── negotiation.ts         # HTML vs JSON
│
└── ui/                        # SSR puro
    ├── escape-html.ts
    ├── layout.ts              # documento, cabecera y pie
    └── pages/
        ├── home.ts
        ├── error.ts
        └── privacy.ts         # política pública (/privacidad)
```

`migrations/`, `seed/` y `public/` siguen en la raíz porque son recursos del
proyecto, no módulos. `src/infra/db/migrate.ts` y `blocklist-store.ts` calculan
su ruta con `../../../` para funcionar igual desde `src/` y desde `dist/`.

## Reglas de dependencia

| Capa | Puede importar | No puede importar |
|---|---|---|
| `domain/` | `domain/`, `net/`, node:crypto, librerías puras (`tldts`) | express, libsql, fs, pino, resto de capas |
| `infra/` | `domain/`, `config`, `logger` | `http/`, `ui/` |
| `security/` | `net/`, node:crypto, node:net | resto del proyecto |
| `net/` | node:net (si hace falta) | resto del proyecto |
| `http/` | `domain/`, `ui/`, `security/`, `http/` | `infra/` (solo `app.ts` cablea) |
| `ui/` | nada del proyecto | `domain`, `infra`, `http`, `security` |
| `app.ts` | todo | — |

El repositorio de enlaces es un puerto: `domain/links/repository.ts` define las
operaciones y `infra/db/links-repository.ts` aporta el SQL. La lógica de dedupe,
cuota y reintento por colisión de alias vive en el dominio, dentro de
`withWriteTransaction`.

## Tests

`tests/` es espejo de `src/`:

- `tests/domain/` — reglas puras y servicio con DB temporal.
- `tests/infra/` — SQL, caché, clics, migraciones y retención.
- `tests/security/` — HMAC, honeypot y rate limiter.
- `tests/net/` — parsers puros de IPv4/IPv6 compartidos.
- `tests/http/` — integración con supertest (`health`, `home`, `api-links`,
  `admin`, `abuse`, `rate-limits`, `regressions`).
- `tests/helpers/` — `temp-db.ts` y `test-app.ts`.

Cada suite HTTP crea su propia app y base de datos temporal con
`createTestApp()` y llama a `cleanup()` al terminar. Vitest solo recoge
`tests/**/*.test.ts`; `tsconfig.json` incluye `tests` para el typecheck, pero
`tsconfig.build.json` compila únicamente `src`.

## Verificación

```bash
npm run typecheck
npm test
npm run build
```

Comprobaciones útiles tras un cambio de estructura:

```bash
# domain no debe acoplarse a la infraestructura
grep -rn "from 'express'\|@libsql/client\|node:fs\|from 'pino" src/domain

# http no debe importar persistencia
grep -rn "src/infra\|\.\./\.\./infra" src/http
```
