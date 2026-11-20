import type { Client, InStatement } from '@libsql/client';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../../logger.js';

/**
 * Buffer de clics.
 *
 * Un `UPDATE` por clic sería una escritura remota por cada redirect. En su
 * lugar se acumulan los clics en memoria y se escriben en lote cada 5 s o al
 * llegar a 200 eventos. A cambio, un crash duro puede perder hasta ~5 s de
 * clics; para eso existe el flush del apagado limpio en `server.ts`.
 *
 * Los clics del mismo alias se agregan en una sola sentencia con
 * `clicks = clicks + ?` y `last_clicked_at` se queda con el mayor timestamp.
 */

export const DEFAULT_CLICK_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_CLICK_BATCH_SIZE = 200;

export type ClickBufferOptions = {
  db: Client;
  intervalMs?: number;
  maxBatch?: number;
  now?: () => Date;
  logger?: Pick<Logger, 'error'>;
};

export type ClickBuffer = {
  record(alias: string, at?: Date): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly pendingCount: number;
};

type PendingClicks = {
  clicks: number;
  lastClickedAt: string;
};

export function createClickBuffer(options: ClickBufferOptions): ClickBuffer {
  const {
    db,
    intervalMs = DEFAULT_CLICK_FLUSH_INTERVAL_MS,
    maxBatch = DEFAULT_CLICK_BATCH_SIZE,
    now = () => new Date(),
    logger = defaultLogger,
  } = options;

  let pending = new Map<string, PendingClicks>();
  let pendingEvents = 0;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function performFlush(): Promise<void> {
    if (pending.size === 0) return;

    const batchEntries = [...pending.entries()];
    const failedEvents = pendingEvents;

    // Intercambio atómico: los clics que lleguen durante el `await` van al
    // mapa nuevo y no se pierden si la escritura falla.
    pending = new Map();
    pendingEvents = 0;

    const statements: InStatement[] = batchEntries.map(
      ([alias, entry]) => ({
        sql: `UPDATE links
                 SET clicks = clicks + ?,
                     last_clicked_at = CASE
                       WHEN last_clicked_at IS NULL OR last_clicked_at < ?
                         THEN ?
                       ELSE last_clicked_at
                     END
               WHERE alias = ?`,
        args: [entry.clicks, entry.lastClickedAt, entry.lastClickedAt, alias],
      }),
    );

    try {
      await db.batch(statements, 'write');
    } catch (error) {
      // Devolver los eventos al buffer para reintentar en el siguiente ciclo.
      for (const [alias, entry] of batchEntries) {
        const current = pending.get(alias);

        if (current) {
          current.clicks += entry.clicks;
          if (entry.lastClickedAt > current.lastClickedAt) {
            current.lastClickedAt = entry.lastClickedAt;
          }
        } else {
          pending.set(alias, { ...entry });
        }
      }

      pendingEvents += failedEvents;
      throw error;
    }
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;

    if (pending.size === 0) return Promise.resolve();

    inFlight = performFlush().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  function logFlushError(error: unknown): void {
    logger.error({ err: error }, 'click_flush_failed');
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void flush().catch(logFlushError);
    }, intervalMs);
    timer.unref();
  }

  return {
    record(alias, at) {
      const clickedAt = (at ?? now()).toISOString();
      const entry = pending.get(alias);

      if (entry) {
        entry.clicks += 1;
        if (clickedAt > entry.lastClickedAt) {
          entry.lastClickedAt = clickedAt;
        }
      } else {
        pending.set(alias, { clicks: 1, lastClickedAt: clickedAt });
      }

      pendingEvents += 1;

      if (maxBatch > 0 && pendingEvents >= maxBatch) {
        void flush().catch(logFlushError);
      }
    },

    flush,

    async close() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      // El primer flush puede ser uno ya en vuelo (hay que esperarlo aunque el
      // mapa esté vacío). Los clics que lleguen durante ese `await` caen en el
      // mapa nuevo, así que se repite hasta drenarlo por completo.
      do {
        await flush();
      } while (pending.size > 0);
    },

    get pendingCount() {
      return pendingEvents;
    },
  };
}
