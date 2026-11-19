import type { Client } from '@libsql/client';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../../logger.js';

/**
 * Retención de IPs.
 *
 * La IP nunca se guarda en claro, solo su HMAC. Pasado el umbral (45 días por
 * defecto, dentro del rango 30–90 del plan) el hash se anonimiza con NULL.
 *
 * Consecuencia consciente: esas filas dejan de contar para la cuota y el
 * dedupe de esa IP. Es el precio de no conservar identificadores de red más
 * tiempo del necesario.
 */

export const DEFAULT_RETENTION_DAYS = 45;
export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type RetentionOptions = {
  db: Client;
  /** Umbral en días. Se ignora si se pasa `retentionMs` (tests). */
  retentionDays?: number | undefined;
  /** Umbral directo en milisegundos; pensado para tests. */
  retentionMs?: number | undefined;
  now?: (() => Date) | undefined;
};

export type RetentionJobOptions = RetentionOptions & {
  intervalMs?: number | undefined;
  logger?: Pick<Logger, 'info' | 'error'> | undefined;
};

export type RetentionJob = {
  runOnce(): Promise<number>;
  start(): void;
  /** Detiene el timer y espera a la pasada que esté en vuelo. */
  stop(): Promise<void>;
};

/** Ejecuta la anonimización una vez y devuelve cuántas filas cambiaron. */
export async function anonymizeOldIpHashes({
  db,
  retentionDays = DEFAULT_RETENTION_DAYS,
  retentionMs,
  now = () => new Date(),
}: RetentionOptions): Promise<number> {
  const thresholdMs =
    retentionMs ?? retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now().getTime() - thresholdMs).toISOString();

  const result = await db.execute({
    sql: `UPDATE links
             SET created_ip_hash = NULL
           WHERE created_ip_hash IS NOT NULL
             AND created_at < ?`,
    args: [cutoff],
  });

  return result.rowsAffected;
}

export function createRetentionJob({
  intervalMs = DEFAULT_RETENTION_INTERVAL_MS,
  logger = defaultLogger,
  ...options
}: RetentionJobOptions): RetentionJob {
  let timer: NodeJS.Timeout | null = null;
  const tasks = new Set<Promise<number>>();

  async function runOnce(): Promise<number> {
    const changed = await anonymizeOldIpHashes(options);

    if (changed > 0) {
      logger.info({ anonymizedRows: changed }, 'ip_retention_complete');
    }

    return changed;
  }

  function launch(): void {
    const task = runOnce();

    tasks.add(task);

    void task
      .catch((error: unknown) => {
        logger.error({ err: error }, 'ip_retention_failed');
      })
      .finally(() => {
        tasks.delete(task);
      });
  }

  return {
    runOnce,

    start() {
      if (timer !== null) return;

      // Primera pasada al arrancar: un deploy no debe retrasar la limpieza.
      launch();

      if (intervalMs > 0) {
        timer = setInterval(launch, intervalMs);
        timer.unref();
      }
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      // `allSettled` porque cada error ya quedó registrado en `launch`.
      await Promise.allSettled([...tasks]);
    },
  };
}
