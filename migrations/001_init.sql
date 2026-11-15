-- Fase 1 · esquema inicial
--
-- Fechas: TEXT ISO-8601 en UTC con milisegundos
-- ('2026-11-13T22:47:56.123Z'). Ese formato se ordena lexicográficamente
-- igual que el tiempo, así que sirve para comparar en SQL sin conversiones.
--
-- DDL idempotente (IF NOT EXISTS): una DB restaurada desde un dump, o un
-- intento anterior que dejó el esquema creado sin registrar la migración,
-- debe poder arrancar en vez de entrar en un bucle de "already exists".
-- Si el esquema preexistente difiere, hay que recrear la DB (ver README).

CREATE TABLE IF NOT EXISTS links (
  -- El alias es la clave natural: al quedar deshabilitado en vez de borrarse,
  -- el alias nunca puede reutilizarse.
  alias TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  -- SHA-256 de la URL normalizada; se usa para deduplicar.
  url_hash TEXT NOT NULL,
  -- Dominio registrable (example.co.uk), para blocklist y estadísticas.
  domain TEXT NOT NULL,
  -- HMAC de la IP; el job de retención lo pone en NULL pasados 30–90 días.
  created_ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  last_clicked_at TEXT,
  disabled_at TEXT,
  disabled_reason TEXT,

  CHECK (length(alias) BETWEEN 3 AND 32),
  CHECK (length(url) BETWEEN 1 AND 4096),
  CHECK (clicks >= 0),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (disabled_reason IS NULL OR disabled_at IS NOT NULL)
);

-- Dedupe: misma URL + misma IP en las últimas 24 h devuelve el alias existente.
CREATE INDEX IF NOT EXISTS idx_links_dedupe
  ON links (url_hash, created_ip_hash, created_at);

-- Cuota: contar enlaces activos de una IP. Parcial porque tras la retención
-- las filas con created_ip_hash NULL ya no cuentan.
CREATE INDEX IF NOT EXISTS idx_links_created_ip_hash
  ON links (created_ip_hash)
  WHERE created_ip_hash IS NOT NULL;

-- Blocklist/estadísticas: agregar o buscar por dominio.
CREATE INDEX IF NOT EXISTS idx_links_domain ON links (domain);

-- Limpieza de vencidos: solo interesan las filas que tienen expiración.
CREATE INDEX IF NOT EXISTS idx_links_expires_at
  ON links (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS blocked_domains (
  -- Un dominio registrable por fila; NOCASE evita duplicar Example.com.
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  -- 'seed' = JSON versionado en el repo; 'manual' = alta desde el endpoint admin.
  source TEXT NOT NULL CHECK (source IN ('seed', 'manual')),
  -- Apagar una entrada sin borrarla conserva el historial de decisiones.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
