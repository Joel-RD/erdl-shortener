-- Fase 8 · índice para el job de retención.
--
-- `anonymizeOldIpHashes` busca filas con `created_ip_hash IS NOT NULL` y
-- `created_at < cutoff`. Un índice parcial sobre `created_at` evita escanear
-- toda la tabla para actualizar solo las filas que aún conservan hash.
-- `IF NOT EXISTS` mantiene la migración segura si el índice ya existe en una
-- DB restaurada cuyo registro de migraciones se perdió.

CREATE INDEX IF NOT EXISTS idx_links_retention
  ON links (created_at)
  WHERE created_ip_hash IS NOT NULL;
