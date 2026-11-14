import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

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

  // Fase 5 añadirá aquí el flush del buffer de clics antes de cerrar.
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'shutdown_failed');
      process.exit(1);
    }

    logger.info('shutdown_complete');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
