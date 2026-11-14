import { createServer } from 'node:http';
import { createApp, getAppRuntime } from './app.js';
import { config } from './config.js';
import { configureDatabase, db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createRetentionJob } from './jobs/retention.js';
import { logger } from './logger.js';

async function start(): Promise<void> {
  // Migrar antes de escuchar: si el esquema está roto, el deploy falla en vez
  // de servir tráfico contra una DB incompleta.
  await configureDatabase(db);
  const appliedMigrations = await runMigrations(db);
  logger.info({ appliedMigrations }, 'database_ready');

  const app = createApp();
  const runtime = getAppRuntime(app);
  const server = createServer(app);
  const retention = createRetentionJob({
    db,
    retentionDays: config.retentionDays,
    logger,
  });

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'server_error');
    process.exit(1);
  });

  server.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, baseUrl: config.baseUrl },
      'server_listening',
    );

    // El job no bloquea el arranque: corre la primera pasada y luego cada 6 h.
    retention.start();
  });

  let shuttingDown = false;

  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown_started');
    const retentionStopped = retention.stop();

    const forceExit = setTimeout(() => {
      logger.error('shutdown_forced');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    // Orden: dejar de aceptar conexiones → vaciar clics → cerrar la DB.
    // Render manda SIGTERM en cada deploy, así que este camino es habitual.
    server.close((error) => {
      void (async () => {
        let exitCode = 0;

        if (error) {
          logger.error({ err: error }, 'shutdown_failed');
          exitCode = 1;
        }

        // La retención pudo quedar a mitad de una pasada; esperarla evita
        // cerrar la DB mientras su UPDATE sigue en vuelo.
        await retentionStopped;

        try {
          await runtime.close();
        } catch (closeError) {
          logger.error({ err: closeError }, 'click_flush_failed');
          exitCode = 1;
        }

        try {
          db.close();
        } catch (closeError) {
          logger.error({ err: closeError }, 'database_close_failed');
          exitCode = 1;
        }

        logger.info({ exitCode }, 'shutdown_complete');
        process.exit(exitCode);
      })();
    });
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  logger.fatal({ err: error }, 'startup_failed');

  try {
    db.close();
  } finally {
    process.exit(1);
  }
});
