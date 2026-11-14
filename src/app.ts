import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 0 ? false : config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url?.split('?')[0] === '/health',
      },
    }),
  );

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    req.log.error({ err }, 'unhandled_error');

    if (res.headersSent) {
      next(err);
      return;
    }

    res.status(500).json({ error: 'internal_error' });
  };

  app.use(errorHandler);

  return app;
}
