import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { configureDatabase, db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './logger.js';

async function start(): Promise<void> {
  // Migrar antes de escuchar: si el esquema está roto, el deploy falla en vez
  // de servir tráfico contra una DB incompleta.
  await configureDatabase(db);
  const appliedMigrations = await runMigrations(db);
  logger.info({ appliedMigrations }, 'database_ready');

  const app = createApp();
  const server = createServer(app);

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'server_error');
    process.exit(1);
  });

  server.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, baseUrl: config.baseUrl },
      'server_listening',
    );
  });

  let shuttingDown = false;

  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown_started');

    const forceExit = setTimeout(() => {
      logger.error('shutdown_forced');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    // Fase 5 añadirá aquí el flush del buffer de clics antes de cerrar la DB.
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'shutdown_failed');
        process.exit(1);
      }

      try {
        db.close();
      } catch (closeError) {
        logger.error({ err: closeError }, 'database_close_failed');
        process.exit(1);
      }

      logger.info('shutdown_complete');
      process.exit(0);
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
