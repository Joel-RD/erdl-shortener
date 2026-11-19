import type { Express } from 'express';

/** Lo mínimo que necesita la sonda: evita acoplar HTTP al cliente concreto. */
type ReadinessProbe = {
  execute(sql: string): Promise<unknown>;
};

/** Sondas de liveness y readiness. */
export function registerHealthRoutes(
  app: Express,
  db: ReadinessProbe,
): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (req, res) => {
    // Un 200 de /health dice que el proceso vive; /ready además comprueba que
    // la DB responde. El timeout evita que Render espere al cliente libSQL.
    let timer: NodeJS.Timeout | undefined;

    try {
      const probe = db.execute('SELECT 1');
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ready_timeout')), 2_000);
        timer.unref();
      });

      await Promise.race([probe, timeout]);
      res.status(200).json({ status: 'ready' });
    } catch (error) {
      req.log?.error?.({ err: error }, 'readiness_failed');
      res.status(503).json({ status: 'unavailable' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}
